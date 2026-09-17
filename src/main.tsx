import React from "react"
import ReactDOM from "react-dom/client"
import App from "./App"
import "./index.css"
import { startRendererLogging, logRendererMounted } from "./lib/logger"

// 前端启动日志：越早调用越好，之后前端日志会写入主进程同一个日志文件
startRendererLogging()

function RendererBootLogger() {
  React.useEffect(() => {
    logRendererMounted({ route: window.location.hash || window.location.pathname })
  }, [])
  return null
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
    <RendererBootLogger />
  </React.StrictMode>
)
