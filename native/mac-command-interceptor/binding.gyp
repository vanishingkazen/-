{
  "targets": [
    {
      "target_name": "mac_command_interceptor",
      "sources": ["src/mac_command_interceptor.mm"],
      "defines": ["NAPI_VERSION=8"],
      "cflags_cc": ["-std=c++17", "-fobjc-arc"],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "MACOSX_DEPLOYMENT_TARGET": "10.15"
      },
      "conditions": [
        ["OS==\"mac\"", {
          "link_settings": {
            "libraries": [
              "-framework ApplicationServices",
              "-framework AppKit",
              "-framework CoreFoundation"
            ]
          }
        }, {
          "sources": []
        }]
      ]
    }
  ]
}
