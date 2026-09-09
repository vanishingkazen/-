// 调试窗口大小问题的脚本
const { screen, BrowserWindow } = require('electron')

function debugWindowSize() {
    console.log('=== 窗口大小调试信息 ===')
    
    // 获取主显示器信息
    const primaryDisplay = screen.getPrimaryDisplay()
    console.log('主显示器信息:')
    console.log(`  工作区域大小 (workAreaSize): ${JSON.stringify(primaryDisplay.workAreaSize)}`)
    console.log(`  缩放因子 (scaleFactor): ${primaryDisplay.scaleFactor}`)
    console.log(`  尺寸 (size): ${JSON.stringify(primaryDisplay.size)}`)
    console.log(` .bounds: ${JSON.stringify(primaryDisplay.bounds)}`)
    
    // 计算逻辑像素和物理像素
    const workArea = primaryDisplay.workAreaSize
    const physicalWidth = workArea.width * primaryDisplay.scaleFactor
    const physicalHeight = workArea.height * primaryDisplay.scaleFactor
    
    console.log(`\n尺寸计算:`)
    console.log(`  逻辑像素: ${workArea.width} x ${workArea.height}`)
    console.log(`  物理像素: ${physicalWidth} x ${physicalHeight}`)
    console.log(`  最大窗口宽度 (50%): ${Math.floor(workArea.width * 0.5)}`)
    
    // 检查所有显示器
    const allDisplays = screen.getAllDisplays()
    console.log(`\n所有显示器 (${allDisplays.length} 个):`)
    allDisplays.forEach((display, index) => {
        console.log(`  显示器 ${index}:`)
        console.log(`    ID: ${display.id}`)
        console.log(`    工作区域: ${JSON.stringify(display.workAreaSize)}`)
        console.log(`    缩放因子: ${display.scaleFactor}`)
        console.log(`    边界: ${JSON.stringify(display.bounds)}`)
    })
    
    // 如果有窗口，获取窗口信息
    const windows = BrowserWindow.getAllWindows()
    if (windows.length > 0) {
        console.log(`\n窗口信息 (${windows.length} 个窗口):`)
        windows.forEach((window, index) => {
            if (!window.isDestroyed()) {
                const bounds = window.getBounds()
                const size = window.getSize()
                const contentBounds = window.getContentBounds()
                
                console.log(`  窗口 ${index}:`)
                console.log(`    标题: ${window.getTitle()}`)
                console.log(`    边界 (getBounds): ${JSON.stringify(bounds)}`)
                console.log(`    大小 (getSize): ${JSON.stringify(size)}`)
                console.log(`    内容边界 (getContentBounds): ${JSON.stringify(contentBounds)}`)
                console.log(`    缩放因子: ${window.webContents.getZoomFactor()}`)
                console.log(`    是否可见: ${window.isVisible()}`)
                console.log(`    是否最小化: ${window.isMinimized()}`)
                console.log(`    是否最大化: ${window.isMaximized()}`)
            }
        })
    } else {
        console.log('\n没有找到窗口')
    }
}

// 如果在Electron环境中运行
if (typeof require !== 'undefined') {
    try {
        const electron = require('electron')
        if (electron.app) {
            electron.app.whenReady().then(debugWindowSize)
        } else {
            debugWindowSize()
        }
    } catch (e) {
        debugWindowSize()
    }
} else {
    debugWindowSize()
}