import { globalShortcut, app } from "electron"
import { IShortcutsHelperDeps } from "./main"
import { configHelper } from "./ConfigHelper"

export class ShortcutsHelper {
  private deps: IShortcutsHelperDeps

  constructor(deps: IShortcutsHelperDeps) {
    this.deps = deps
  }

  private adjustOpacity(delta: number): void {
    const mainWindow = this.deps.getMainWindow();
    if (!mainWindow) return;
    
    let currentOpacity = mainWindow.getOpacity();
    let newOpacity = Math.max(0.1, Math.min(1.0, currentOpacity + delta));
    console.log(`Adjusting opacity from ${currentOpacity} to ${newOpacity}`);
    
    mainWindow.setOpacity(newOpacity);
    
    // Save the opacity setting to config without re-initializing the client
    try {
      const config = configHelper.loadConfig();
      config.opacity = newOpacity;
      configHelper.saveConfig(config);
    } catch (error) {
      console.error('Error saving opacity to config:', error);
    }
    
    // If we're making the window visible, also make sure it's shown and interaction is enabled
    if (newOpacity > 0.1 && !this.deps.isVisible()) {
      this.deps.toggleMainWindow();
    }
  }

  public registerGlobalShortcuts(): void {
    globalShortcut.register("CommandOrControl+H", async () => {
      const mainWindow = this.deps.getMainWindow()
      if (mainWindow) {
        console.log("Taking screenshot...")
        try {
          const screenshotPath = await this.deps.takeScreenshot()
          const preview = await this.deps.getImagePreview(screenshotPath)
          mainWindow.webContents.send("screenshot-taken", {
            path: screenshotPath,
            preview
          })
        } catch (error) {
          console.error("Error capturing screenshot:", error)
        }
      }
    })

    globalShortcut.register("CommandOrControl+Enter", async () => {
      const rawConversation = this.deps.voiceRecognitionHelper?.getConversationTranscript()
      const conversation = rawConversation
        ? await this.deps.processingHelper?.correctVoiceConversation(rawConversation) || rawConversation
        : undefined
      const voiceText = [
        conversation?.systemTranscript ? `用户A（扬声器）：${conversation.systemTranscript}` : "",
        conversation?.microphoneTranscript ? `用户B（麦克风）：${conversation.microphoneTranscript}` : ""
      ].filter(Boolean).join("\n")
      const hasScreenshots = this.deps.getView() === "queue"
        ? this.deps.getScreenshotQueue().length > 0
        : this.deps.getExtraScreenshotQueue().length > 0

      // Ctrl+Enter is a submit shortcut, not an instruction to create an
      // empty screenshot job. With no voice text and no queued image it is a
      // deliberate no-op.
      if (!voiceText && !hasScreenshots) return

      if (voiceText && !hasScreenshots) {
        const requestId = `voice-${Date.now()}`
        this.deps.getMainWindow()?.webContents.send("voice-submit", {
          requestId,
          text: voiceText
        })
        this.deps.voiceRecognitionHelper?.clearTranscript()
        await this.deps.processingHelper?.processChatMessage(requestId, voiceText)
        return
      }

      await this.deps.processingHelper?.processScreenshots(voiceText)
      if (voiceText) this.deps.voiceRecognitionHelper?.clearTranscript()
    })

    globalShortcut.register("CommandOrControl+R", () => {
      console.log(
        "Command + R pressed. Canceling requests and resetting queues..."
      )

      // Cancel ongoing API requests
      this.deps.processingHelper?.cancelOngoingRequests()
      void this.deps.voiceRecognitionHelper?.stop("system")
      void this.deps.voiceRecognitionHelper?.stop("microphone")
      this.deps.voiceRecognitionHelper?.clearTranscript()

      // Clear both screenshot queues
      this.deps.clearQueues()

      console.log("Cleared queues.")

      // Update the view state to 'queue'
      this.deps.setView("queue")

      // Notify renderer process to switch view to 'queue'
      const mainWindow = this.deps.getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("reset-view")
        mainWindow.webContents.send("reset")
      }
    })

    // New shortcuts for moving the window
    globalShortcut.register("CommandOrControl+Left", () => {
      console.log("Command/Ctrl + Left pressed. Moving window left.")
      this.deps.moveWindowLeft()
    })

    globalShortcut.register("CommandOrControl+Right", () => {
      console.log("Command/Ctrl + Right pressed. Moving window right.")
      this.deps.moveWindowRight()
    })

    globalShortcut.register("CommandOrControl+Down", () => {
      console.log("Command/Ctrl + down pressed. Moving window down.")
      this.deps.moveWindowDown()
    })

    globalShortcut.register("CommandOrControl+Up", () => {
      console.log("Command/Ctrl + Up pressed. Moving window Up.")
      this.deps.moveWindowUp()
    })

    globalShortcut.register("CommandOrControl+Shift+0", () => {
      console.log("Command/Ctrl + Shift + 0 pressed. Resetting window position.")
      this.deps.resetWindowPosition()
    })

    globalShortcut.register("CommandOrControl+B", () => {
      console.log("Command/Ctrl + B pressed. Toggling window visibility.")
      this.deps.toggleMainWindow()
    })

    globalShortcut.register("CommandOrControl+K", () => {
      console.log("Command/Ctrl + K pressed. Focusing chat input.")
      const mainWindow = this.deps.getMainWindow()
      if (!mainWindow || mainWindow.isDestroyed()) return

      if (!this.deps.isVisible()) this.deps.toggleMainWindow()
      mainWindow.show()
      mainWindow.focus()
      mainWindow.webContents.focus()
      mainWindow.webContents.send("focus-chat-input")
    })

    globalShortcut.register("CommandOrControl+Shift+M", () => {
      console.log("Command/Ctrl + Shift + M pressed. Toggling voice input.")
      const mainWindow = this.deps.getMainWindow()
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.send("toggle-voice-input")
    })

    globalShortcut.register("CommandOrControl+Alt+Up", () => {
      console.log("Command/Ctrl + Alt + Up pressed. Scrolling chat up.")
      const mainWindow = this.deps.getMainWindow()
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.send("scroll-chat", { direction: "up" })
    })

    globalShortcut.register("CommandOrControl+Alt+Down", () => {
      console.log("Command/Ctrl + Alt + Down pressed. Scrolling chat down.")
      const mainWindow = this.deps.getMainWindow()
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.send("scroll-chat", { direction: "down" })
    })

    globalShortcut.register("CommandOrControl+Q", () => {
      console.log("Command/Ctrl + Q pressed. Quitting application.")
      app.quit()
    })

    // Adjust opacity shortcuts
    globalShortcut.register("CommandOrControl+[", () => {
      console.log("Command/Ctrl + [ pressed. Decreasing opacity.")
      this.adjustOpacity(-0.1)
    })

    globalShortcut.register("CommandOrControl+]", () => {
      console.log("Command/Ctrl + ] pressed. Increasing opacity.")
      this.adjustOpacity(0.1)
    })
    
    // Zoom controls
    globalShortcut.register("CommandOrControl+-", () => {
      console.log("Command/Ctrl + - pressed. Zooming out.")
      const mainWindow = this.deps.getMainWindow()
      if (mainWindow) {
        const currentZoom = mainWindow.webContents.getZoomLevel()
        mainWindow.webContents.setZoomLevel(currentZoom - 0.5)
      }
    })
    
    globalShortcut.register("CommandOrControl+0", () => {
      console.log("Command/Ctrl + 0 pressed. Resetting zoom.")
      const mainWindow = this.deps.getMainWindow()
      if (mainWindow) {
        mainWindow.webContents.setZoomLevel(0)
      }
    })
    
    globalShortcut.register("CommandOrControl+=", () => {
      console.log("Command/Ctrl + = pressed. Zooming in.")
      const mainWindow = this.deps.getMainWindow()
      if (mainWindow) {
        const currentZoom = mainWindow.webContents.getZoomLevel()
        mainWindow.webContents.setZoomLevel(currentZoom + 0.5)
      }
    })
    
    // Delete last screenshot shortcut
    globalShortcut.register("CommandOrControl+L", () => {
      console.log("Command/Ctrl + L pressed. Deleting last screenshot.")
      const mainWindow = this.deps.getMainWindow()
      if (mainWindow) {
        // Send an event to the renderer to delete the last screenshot
        mainWindow.webContents.send("delete-last-screenshot")
      }
    })
    
    // Unregister shortcuts when quitting
    app.on("will-quit", () => {
      globalShortcut.unregisterAll()
    })
  }
}
