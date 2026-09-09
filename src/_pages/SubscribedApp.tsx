import { useEffect, useRef, type FC } from "react"
import Chat from "./Chat"

interface SubscribedAppProps {
  credits: number
  currentLanguage: string
  setLanguage: (language: string) => void
}

const SubscribedApp: FC<SubscribedAppProps> = ({
  credits,
  currentLanguage,
  setLanguage
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
        credits={credits}
        currentLanguage={currentLanguage}
        setLanguage={setLanguage}
      />
    </div>
  )
}

export default SubscribedApp
