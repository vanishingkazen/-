import { useEffect, useRef, type FC } from "react"
import Chat from "./Chat"

interface SubscribedAppProps {
  currentLanguage: string
}

const SubscribedApp: FC<SubscribedAppProps> = ({
  currentLanguage,
}) => {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Messages scroll inside the stable chat viewport instead of continuously
    // resizing the transparent Electron window.
    window.electronAPI.updateContentDimensions({ width: 820, height: 720 })
  }, [])

  return (
    <div ref={containerRef} className="min-h-0">
      <Chat
        currentLanguage={currentLanguage}
      />
    </div>
  )
}

export default SubscribedApp
