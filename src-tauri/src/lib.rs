//! 桌面壳：窗口加载本地控制台页面；打包运行时负责拉起 Node 服务进程。
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread::sleep;
use std::time::Duration;

use tauri::{Manager, RunEvent};

const UI_PORT: u16 = 8787;

/// 由 Tauri 托管，应用退出时回收子进程
pub struct ConsoleProcess(pub Mutex<Option<Child>>);

fn port_open() -> bool {
    use std::net::TcpStream;
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], UI_PORT));
    TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok()
}

fn node_binary() -> Option<PathBuf> {
    if let Ok(custom) = std::env::var("RTMP_NODE") {
        let p = PathBuf::from(custom);
        if p.exists() {
            return Some(p);
        }
    }
    for p in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] {
        let path = PathBuf::from(p);
        if path.exists() {
            return Some(path);
        }
    }
    // 回落到登录 shell 的 PATH（nvm / fnm 等场景）
    let out = Command::new("sh")
        .arg("-lc")
        .arg("command -v node")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!text.is_empty()).then(|| PathBuf::from(text))
}

/// 在 Resources 下（最多 4 层）找 <dir_name>/<file_name>
/// Tauri 会把 ../server、../vendor 打进 Resources/_up_/ 下，所以要做深度搜索
fn find_resource(root: &Path, dir_name: &str, file_name: &str) -> Option<PathBuf> {
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        if dir.file_name().and_then(|n| n.to_str()) == Some(dir_name) {
            let candidate = dir.join(file_name);
            if candidate.exists() {
                return Some(candidate);
            }
        }
        if depth >= 4 {
            continue;
        }
        if let Ok(read) = fs::read_dir(&dir) {
            for entry in read.flatten() {
                if entry.path().is_dir() {
                    stack.push((entry.path(), depth + 1));
                }
            }
        }
    }
    None
}

fn server_entry(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(dir) = app.path().resource_dir() {
        if let Some(found) = find_resource(&dir, "server", "index.js") {
            return Some(found);
        }
    }
    // 开发模式：src-tauri/../server/index.js
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/index.js");
    dev.exists().then_some(dev)
}

fn terminate(child: &mut Child) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(child.id().to_string())
            .status();
        for _ in 0..20 {
            match child.try_wait() {
                Ok(Some(_)) => return,
                _ => sleep(Duration::from_millis(100)),
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn vendor_resource(app: &tauri::AppHandle, name: &str) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?;
    find_resource(&dir, "vendor", name)
}

fn spawn_console(app: &tauri::AppHandle) {
    if port_open() {
        // 已有实例（例如终端里 npm start 过），直接复用
        return;
    }
    // 优先用包内自带的 node，其次系统 node
    let Some(node) = vendor_resource(app, "node").or_else(node_binary) else {
        eprintln!("LocalRTMP: 未找到 node，可设置 RTMP_NODE 指定可执行文件");
        return;
    };
    let Some(entry) = server_entry(app) else {
        eprintln!("LocalRTMP: 未找到控制台入口 server/index.js");
        return;
    };
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("localrtmp-studio"));
    let _ = fs::create_dir_all(&data_dir);
    let log_file: Option<File> = OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_dir.join("console.log"))
        .ok();

    let mut cmd = Command::new(&node);
    cmd.arg(&entry)
        .env("RTMP_HOME", &data_dir)
        .current_dir(entry.parent().unwrap_or(Path::new("/")))
        .stdin(Stdio::null());
    if let Some(mtx) = vendor_resource(app, "mediamtx") {
        cmd.env("RTMP_MEDIAMTX_BIN", mtx);
    }
    if let Some(ff) = vendor_resource(app, "ffmpeg") {
        cmd.env("RTMP_FFMPEG_BIN", ff);
    }
    match log_file {
        Some(f) => match f.try_clone() {
            Ok(stderr) => {
                cmd.stdout(Stdio::from(f));
                cmd.stderr(Stdio::from(stderr));
            }
            Err(_) => {
                cmd.stdout(Stdio::from(f));
                cmd.stderr(Stdio::null());
            }
        },
        None => {
            cmd.stdout(Stdio::null());
            cmd.stderr(Stdio::null());
        }
    }

    match cmd.spawn() {
        Ok(child) => {
            if let Ok(mut slot) = app.state::<ConsoleProcess>().0.lock() {
                *slot = Some(child);
            }
            // 等端口就绪，避免窗口先于服务出现
            for _ in 0..50 {
                if port_open() {
                    break;
                }
                sleep(Duration::from_millis(200));
            }
        }
        Err(err) => eprintln!("LocalRTMP: 控制台进程启动失败: {}", err),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ConsoleProcess(Mutex::new(None)))
        .setup(|app| {
            // 开发模式下 node 由 beforeDevCommand 启动，这里只处理打包后的运行
            if !cfg!(debug_assertions) {
                spawn_console(&app.handle().clone());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("LocalRTMP Studio 启动失败")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app.try_state::<ConsoleProcess>() {
                    if let Ok(mut slot) = state.0.lock() {
                        if let Some(mut child) = slot.take() {
                            terminate(&mut child);
                        }
                    }
                }
            }
        });
}
