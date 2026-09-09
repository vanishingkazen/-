using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace SteamgamecodeLauncher;

internal static class Program
{
    private const string MutexName = "steamgamecode-launcher-5D42727A-14E2-4C79-9122-DC7DB9026C76";
    private const string LaunchEventName = "steamgamecode-launcher-launch-99889F5B-3770-4C54-88BB-41FA0B167D40";

    [STAThread]
    private static void Main(string[] args)
    {
        using var launchEvent = new EventWaitHandle(
            false, EventResetMode.AutoReset, LaunchEventName);
        using var mutex = new Mutex(true, MutexName, out var isFirstInstance);
        if (!isFirstInstance)
        {
            launchEvent.Set();
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new TrayApplicationContext(ResolveTarget(args), launchEvent));
    }

    private static string ResolveTarget(string[] args)
    {
        var targetIndex = Array.FindIndex(args, value =>
            string.Equals(value, "--target", StringComparison.OrdinalIgnoreCase));
        if (targetIndex >= 0 && targetIndex + 1 < args.Length)
        {
            var requestedTarget = Path.GetFullPath(args[targetIndex + 1]);
            if (File.Exists(requestedTarget))
            {
                return requestedTarget;
            }
        }

        var baseDirectory = AppContext.BaseDirectory;
        var candidates = new[]
        {
            Path.Combine(baseDirectory, "steamgamecode.exe"),
            Path.GetFullPath(Path.Combine(baseDirectory, "..", "win-unpacked", "steamgamecode.exe")),
            Path.GetFullPath(Path.Combine(baseDirectory, "..", "release", "win-unpacked", "steamgamecode.exe"))
        };

        return candidates.FirstOrDefault(File.Exists) ?? candidates[1];
    }
}

internal sealed class TrayApplicationContext : ApplicationContext
{
    private const string StartupValueName = "steamgamecode-launcher";
    private readonly string targetPath;
    private readonly NotifyIcon trayIcon;
    private readonly HotKeyWindow hotKeyWindow;
    private readonly System.Windows.Forms.Timer launchSignalTimer;
    private readonly EventWaitHandle launchEvent;

    public TrayApplicationContext(string targetPath, EventWaitHandle launchEvent)
    {
        this.targetPath = targetPath;
        this.launchEvent = launchEvent;
        EnsureStartsWithWindows();

        var menu = new ContextMenuStrip();
        menu.Items.Add("启动 / 显示 steamgamecode", null, (_, _) => LaunchOrShow());
        menu.Items.Add("关闭 steamgamecode", null, (_, _) => CloseSteamgamecode());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("全局快捷键：Ctrl + Alt + Q") { Enabled = false });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出启动器", null, (_, _) => ExitThread());

        trayIcon = new NotifyIcon
        {
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application,
            Text = "steamgamecode 启动器（Ctrl + Alt + Q）",
            ContextMenuStrip = menu,
            Visible = true
        };
        trayIcon.DoubleClick += (_, _) => LaunchOrShow();

        launchSignalTimer = new System.Windows.Forms.Timer { Interval = 200 };
        launchSignalTimer.Tick += (_, _) =>
        {
            if (this.launchEvent.WaitOne(0))
            {
                LaunchOrShow();
            }
        };
        launchSignalTimer.Start();

        hotKeyWindow = new HotKeyWindow(LaunchOrShow);
        if (!hotKeyWindow.Register())
        {
            trayIcon.BalloonTipTitle = "steamgamecode 启动器";
            trayIcon.BalloonTipText = "Ctrl + Alt + Q 已被其他程序占用，请使用托盘菜单启动。";
            trayIcon.ShowBalloonTip(5000);
        }
    }

    private void EnsureStartsWithWindows()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Run", writable: true);
            // Keep the startup entry relocatable. ResolveTarget derives the
            // application path from the launcher's current directory.
            var command = $"\"{Application.ExecutablePath}\"";
            key?.SetValue(StartupValueName, command, RegistryValueKind.String);
        }
        catch
        {
            // The launcher still works when startup registration is blocked by policy.
        }
    }

    private void LaunchOrShow()
    {
        if (!File.Exists(targetPath))
        {
            trayIcon.BalloonTipTitle = "找不到 steamgamecode";
            trayIcon.BalloonTipText = $"主程序不存在：{targetPath}";
            trayIcon.ShowBalloonTip(5000);
            return;
        }

        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = targetPath,
                WorkingDirectory = Path.GetDirectoryName(targetPath)!,
                UseShellExecute = false
            };
            startInfo.Environment.Remove("ELECTRON_RUN_AS_NODE");
            Process.Start(startInfo);
        }
        catch (Exception error)
        {
            trayIcon.BalloonTipTitle = "启动失败";
            trayIcon.BalloonTipText = error.Message;
            trayIcon.ShowBalloonTip(5000);
        }
    }

    private void CloseSteamgamecode()
    {
        foreach (var process in Process.GetProcessesByName("steamgamecode"))
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch
            {
                // A process may already have exited or be inaccessible.
            }
            finally
            {
                process.Dispose();
            }
        }
    }

    protected override void ExitThreadCore()
    {
        launchSignalTimer.Stop();
        launchSignalTimer.Dispose();
        hotKeyWindow.Dispose();
        trayIcon.Visible = false;
        trayIcon.Dispose();
        base.ExitThreadCore();
    }
}

internal sealed class HotKeyWindow : NativeWindow, IDisposable
{
    private const int HotKeyId = 0x5347;
    private const int WmHotKey = 0x0312;
    private const uint ModAlt = 0x0001;
    private const uint ModControl = 0x0002;
    private const uint VkQ = 0x51;
    private readonly Action callback;
    private bool registered;

    public HotKeyWindow(Action callback)
    {
        this.callback = callback;
        CreateHandle(new CreateParams());
    }

    public bool Register()
    {
        registered = RegisterHotKey(Handle, HotKeyId, ModControl | ModAlt, VkQ);
        return registered;
    }

    protected override void WndProc(ref Message message)
    {
        if (message.Msg == WmHotKey && message.WParam.ToInt32() == HotKeyId)
        {
            callback();
        }

        base.WndProc(ref message);
    }

    public void Dispose()
    {
        if (registered)
        {
            UnregisterHotKey(Handle, HotKeyId);
            registered = false;
        }

        DestroyHandle();
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr windowHandle, int id, uint modifiers, uint virtualKey);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnregisterHotKey(IntPtr windowHandle, int id);
}
