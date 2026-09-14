#include <node_api.h>
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

namespace {

struct ShortcutSpec {
  std::string action;
  int64_t keyCode;
  bool shift;
  bool option;
  bool control;
};

std::atomic<bool> gEnabled{false};
std::atomic<bool> gRunning{false};
std::atomic<bool> gStartCompleted{false};
std::atomic<bool> gStartSuccess{false};

std::mutex gStateMutex;
std::condition_variable gStartCondition;
std::thread gTapThread;
CFRunLoopRef gRunLoop = nullptr;
CFRunLoopSourceRef gRunLoopSource = nullptr;
CFMachPortRef gEventTap = nullptr;

std::vector<ShortcutSpec> gShortcuts;
std::vector<std::string> gPendingActions;
std::set<std::string> gBrowserBundleIds = {
  "com.google.Chrome",
  "com.google.Chrome.canary",
  "com.apple.Safari",
  "com.microsoft.edgemac",
  "com.brave.Browser",
  "company.thebrowser.Browser",
  "com.operasoftware.Opera",
  "com.vivaldi.Vivaldi",
  "org.mozilla.firefox"
};

bool gCommandPending = false;
bool gCommandObserved = false;
bool gCommandHidden = false;
bool gCommandForwarded = false;
bool gCommandShortcutConsumed = false;
int64_t gConsumedKeyCode = -1;
CGEventRef gBufferedCommandDown = nullptr;
thread_local bool gReplayingEvent = false;

constexpr int64_t kLeftCommandKeyCode = 55;
constexpr int64_t kRightCommandKeyCode = 54;

bool isCommandKeyCode(int64_t keyCode) {
  return keyCode == kLeftCommandKeyCode || keyCode == kRightCommandKeyCode;
}

bool isCommandDown(CGEventRef event) {
  return (CGEventGetFlags(event) & kCGEventFlagMaskCommand) != 0;
}

void releaseBufferedCommandLocked() {
  if (gBufferedCommandDown) {
    CFRelease(gBufferedCommandDown);
    gBufferedCommandDown = nullptr;
  }
}

void resetPendingStateLocked() {
  gCommandPending = false;
  gCommandObserved = false;
  gCommandHidden = false;
  gCommandForwarded = false;
  gCommandShortcutConsumed = false;
  gConsumedKeyCode = -1;
  releaseBufferedCommandLocked();
}

bool browserBundleMatches(const std::string& bundleId) {
  std::lock_guard<std::mutex> lock(gStateMutex);
  return gBrowserBundleIds.find(bundleId) != gBrowserBundleIds.end();
}

bool isBrowserFrontmost() {
  @autoreleasepool {
    NSRunningApplication* app = [[NSWorkspace sharedWorkspace] frontmostApplication];
    NSString* bundleId = app.bundleIdentifier;
    if (!bundleId) return false;
    const char* utf8 = bundleId.UTF8String;
    if (!utf8) return false;
    return browserBundleMatches(std::string(utf8));
  }
}

bool shortcutMatches(const ShortcutSpec& shortcut, int64_t keyCode, CGEventFlags flags) {
  const bool shift = (flags & kCGEventFlagMaskShift) != 0;
  const bool option = (flags & kCGEventFlagMaskAlternate) != 0;
  const bool control = (flags & kCGEventFlagMaskControl) != 0;
  return shortcut.keyCode == keyCode &&
         shortcut.shift == shift &&
         shortcut.option == option &&
         shortcut.control == control;
}

void postBufferedCommandDown() {
  CGEventRef event = nullptr;
  {
    std::lock_guard<std::mutex> lock(gStateMutex);
    event = gBufferedCommandDown;
    gBufferedCommandDown = nullptr;
    gCommandPending = false;
    gCommandObserved = false;
    gCommandHidden = false;
    gCommandForwarded = true;
  }

  if (!event) return;
  gReplayingEvent = true;
  CGEventPost(kCGSessionEventTap, event);
  gReplayingEvent = false;
  CFRelease(event);
}

CGEventRef eventTapCallback(
  CGEventTapProxy proxy,
  CGEventType type,
  CGEventRef event,
  void* userInfo
) {
  (void)proxy;
  (void)userInfo;

  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
    if (gEventTap) CGEventTapEnable(gEventTap, true);
    return event;
  }

  if (gReplayingEvent) return event;

  const int64_t keyCode = (int64_t)CGEventGetIntegerValueField(
    event,
    kCGKeyboardEventKeycode
  );

  if (type == kCGEventFlagsChanged && isCommandKeyCode(keyCode)) {
    const bool commandDown = isCommandDown(event);
    const bool browserFocused = gEnabled.load() && isBrowserFrontmost();
    std::lock_guard<std::mutex> lock(gStateMutex);

    if (commandDown) {
      if (!gEnabled.load()) return event;
      if (!browserFocused) {
        gCommandObserved = true;
        return event;
      }
      if (gCommandForwarded || gCommandShortcutConsumed) return event;
      if (!gCommandPending) {
        gCommandPending = true;
        gCommandHidden = true;
        gBufferedCommandDown = CGEventCreateCopy(event);
      }
      return nullptr;
    }

    if (gCommandPending) {
      releaseBufferedCommandLocked();
      gCommandPending = false;
      return nullptr;
    }

    if (gCommandShortcutConsumed) {
      const bool hideCommandUp = gCommandHidden;
      gCommandShortcutConsumed = false;
      gCommandObserved = false;
      gCommandHidden = false;
      gConsumedKeyCode = -1;
      return hideCommandUp ? nullptr : event;
    }

    if (gCommandForwarded) {
      gCommandForwarded = false;
      return event;
    }

    if (gCommandObserved) {
      gCommandObserved = false;
      return event;
    }

    return event;
  }

  if (!gEnabled.load()) return event;

  bool hasCommandState = false;
  {
    std::lock_guard<std::mutex> lock(gStateMutex);
    hasCommandState = gCommandPending || gCommandObserved || gCommandForwarded || gCommandShortcutConsumed;
  }
  if (!hasCommandState && !isBrowserFrontmost()) return event;

  if (type == kCGEventKeyDown || type == kCGEventKeyUp) {
    std::vector<std::string> actions;
    bool swallow = false;
    bool forwardPending = false;

    {
      std::lock_guard<std::mutex> lock(gStateMutex);

      if (gCommandShortcutConsumed) {
        swallow = true;
      } else if (gCommandPending || gCommandObserved) {
        ShortcutSpec matched{};
        bool found = false;

        for (const auto& shortcut : gShortcuts) {
          if (shortcutMatches(shortcut, keyCode, CGEventGetFlags(event))) {
            matched = shortcut;
            found = true;
            break;
          }
        }

        if (found && type == kCGEventKeyDown) {
          actions.push_back(matched.action);
          gCommandShortcutConsumed = true;
          gConsumedKeyCode = keyCode;
          gCommandPending = false;
          gCommandObserved = false;
          releaseBufferedCommandLocked();
          swallow = true;
        } else if (found && type == kCGEventKeyUp) {
          swallow = true;
        } else if (gCommandPending) {
          forwardPending = true;
        }
      }
    }

    for (const auto& action : actions) {
      std::lock_guard<std::mutex> lock(gStateMutex);
      gPendingActions.push_back(action);
    }

    if (forwardPending) postBufferedCommandDown();
    if (swallow) return nullptr;
  }

  return event;
}

void stopEventTap() {
  gRunning.store(false);

  CFRunLoopRef runLoop = nullptr;
  {
    std::lock_guard<std::mutex> lock(gStateMutex);
    runLoop = gRunLoop;
    resetPendingStateLocked();
  }

  if (runLoop) CFRunLoopStop(runLoop);
  if (gTapThread.joinable()) gTapThread.join();
}

void eventTapThread() {
  @autoreleasepool {
    CGEventMask mask =
      CGEventMaskBit(kCGEventKeyDown) |
      CGEventMaskBit(kCGEventKeyUp) |
      CGEventMaskBit(kCGEventFlagsChanged);

    gEventTap = CGEventTapCreate(
      kCGSessionEventTap,
      kCGHeadInsertEventTap,
      kCGEventTapOptionDefault,
      mask,
      eventTapCallback,
      nullptr
    );

    if (!gEventTap) {
      {
        std::lock_guard<std::mutex> lock(gStateMutex);
        gRunLoop = nullptr;
      }
      gStartSuccess.store(false);
      gStartCompleted.store(true);
      gStartCondition.notify_all();
      gRunning.store(false);
      return;
    }

    gRunLoop = CFRunLoopGetCurrent();
    CFRetain(gRunLoop);
    gRunLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, gEventTap, 0);
    CFRunLoopAddSource(gRunLoop, gRunLoopSource, kCFRunLoopCommonModes);
    CGEventTapEnable(gEventTap, true);

    gStartSuccess.store(true);
    gStartCompleted.store(true);
    gStartCondition.notify_all();

    CFRunLoopRun();

    if (gRunLoopSource) {
      CFRunLoopRemoveSource(gRunLoop, gRunLoopSource, kCFRunLoopCommonModes);
      CFRelease(gRunLoopSource);
      gRunLoopSource = nullptr;
    }
    if (gEventTap) {
      CFMachPortInvalidate(gEventTap);
      CFRelease(gEventTap);
      gEventTap = nullptr;
    }
    if (gRunLoop) {
      CFRelease(gRunLoop);
      gRunLoop = nullptr;
    }
  }
}

napi_value makeBoolean(napi_env env, bool value) {
  napi_value result;
  napi_get_boolean(env, value, &result);
  return result;
}

bool getNamedBoolean(napi_env env, napi_value object, const char* name, bool* result) {
  napi_value value;
  if (napi_get_named_property(env, object, name, &value) != napi_ok) return false;
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_boolean) return false;
  return napi_get_value_bool(env, value, result) == napi_ok;
}

napi_value start(napi_env env, napi_callback_info info) {
  (void)info;
  if (gRunning.load()) return makeBoolean(env, true);
  stopEventTap();

  gStartCompleted.store(false);
  gStartSuccess.store(false);
  gRunning.store(true);
  gTapThread = std::thread(eventTapThread);

  std::unique_lock<std::mutex> lock(gStateMutex);
  gStartCondition.wait_for(lock, std::chrono::seconds(3), [] {
    return gStartCompleted.load();
  });
  const bool success = gStartCompleted.load() && gStartSuccess.load();
  lock.unlock();

  if (!success) stopEventTap();
  return makeBoolean(env, success);
}

napi_value stop(napi_env env, napi_callback_info info) {
  (void)info;
  stopEventTap();
  return makeBoolean(env, true);
}

napi_value setEnabled(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 1) return makeBoolean(env, false);

  bool enabled = false;
  if (napi_get_value_bool(env, args[0], &enabled) != napi_ok) {
    return makeBoolean(env, false);
  }

  gEnabled.store(enabled);
  if (!enabled) {
    std::lock_guard<std::mutex> lock(gStateMutex);
    resetPendingStateLocked();
  }
  return makeBoolean(env, true);
}

napi_value isTrusted(napi_env env, napi_callback_info info) {
  (void)info;
  return makeBoolean(env, AXIsProcessTrusted());
}

napi_value requestPermission(napi_env env, napi_callback_info info) {
  (void)info;
  NSDictionary* options = @{ (__bridge id)kAXTrustedCheckOptionPrompt: @YES };
  return makeBoolean(env, AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options));
}

napi_value setShortcuts(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 1) return makeBoolean(env, false);

  bool isArray = false;
  if (napi_is_array(env, args[0], &isArray) != napi_ok || !isArray) {
    return makeBoolean(env, false);
  }

  uint32_t length = 0;
  napi_get_array_length(env, args[0], &length);
  std::vector<ShortcutSpec> shortcuts;
  shortcuts.reserve(length);

  for (uint32_t index = 0; index < length; index++) {
    napi_value item;
    if (napi_get_element(env, args[0], index, &item) != napi_ok) continue;

    napi_value actionValue;
    napi_value keyCodeValue;
    bool shift = false;
    bool option = false;
    bool control = false;

    if (napi_get_named_property(env, item, "action", &actionValue) != napi_ok) continue;
    if (napi_get_named_property(env, item, "keyCode", &keyCodeValue) != napi_ok) continue;
    getNamedBoolean(env, item, "shift", &shift);
    getNamedBoolean(env, item, "option", &option);
    getNamedBoolean(env, item, "control", &control);

    size_t actionLength = 0;
    if (napi_get_value_string_utf8(env, actionValue, nullptr, 0, &actionLength) != napi_ok) continue;
    std::string action(actionLength, '\0');
    if (napi_get_value_string_utf8(env, actionValue, &action[0], actionLength + 1, &actionLength) != napi_ok) continue;

    int32_t keyCode = 0;
    if (napi_get_value_int32(env, keyCodeValue, &keyCode) != napi_ok) continue;

    shortcuts.push_back({ action, keyCode, shift, option, control });
  }

  {
    std::lock_guard<std::mutex> lock(gStateMutex);
    gShortcuts = std::move(shortcuts);
  }
  return makeBoolean(env, true);
}

napi_value setBrowserBundleIds(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 1) return makeBoolean(env, false);

  bool isArray = false;
  if (napi_is_array(env, args[0], &isArray) != napi_ok || !isArray) {
    return makeBoolean(env, false);
  }

  uint32_t length = 0;
  napi_get_array_length(env, args[0], &length);
  std::set<std::string> bundleIds;

  for (uint32_t index = 0; index < length; index++) {
    napi_value item;
    if (napi_get_element(env, args[0], index, &item) != napi_ok) continue;
    size_t valueLength = 0;
    if (napi_get_value_string_utf8(env, item, nullptr, 0, &valueLength) != napi_ok) continue;
    std::string value(valueLength, '\0');
    if (napi_get_value_string_utf8(env, item, &value[0], valueLength + 1, &valueLength) != napi_ok) continue;
    bundleIds.insert(value);
  }

  {
    std::lock_guard<std::mutex> lock(gStateMutex);
    gBrowserBundleIds = std::move(bundleIds);
  }
  return makeBoolean(env, true);
}

napi_value pollActions(napi_env env, napi_callback_info info) {
  (void)info;
  std::vector<std::string> actions;
  {
    std::lock_guard<std::mutex> lock(gStateMutex);
    actions.swap(gPendingActions);
  }

  napi_value result;
  napi_create_array_with_length(env, actions.size(), &result);
  for (size_t index = 0; index < actions.size(); index++) {
    napi_value value;
    napi_create_string_utf8(env, actions[index].c_str(), NAPI_AUTO_LENGTH, &value);
    napi_set_element(env, result, index, value);
  }
  return result;
}

napi_value initialize(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    { "start", nullptr, start, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "stop", nullptr, stop, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "setEnabled", nullptr, setEnabled, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "isTrusted", nullptr, isTrusted, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "requestPermission", nullptr, requestPermission, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "setShortcuts", nullptr, setShortcuts, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "setBrowserBundleIds", nullptr, setBrowserBundleIds, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "pollActions", nullptr, pollActions, nullptr, nullptr, nullptr, napi_default, nullptr }
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

}  // namespace

NAPI_MODULE_INIT() {
  return initialize(env, exports);
}
