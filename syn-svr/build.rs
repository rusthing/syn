//! # 构建脚本
//!
//! 把**运行期才读**的文件从 crate 根目录搬到 `target/<profile>/` 旁边，这样二进制
//! 可以在任意工作目录启动：`cargo run` 与容器里 `/app/syn-svr` 的行为一致。
//!
//! 搬什么（与兄弟服务同一套约定）：
//!
//! | 来源 | 目标 | 谁在用 |
//! |---|---|---|
//! | `syn-svr.toml` / `syn-svr-dev.toml` / `-test` / `-prod` | 同名的 `target/<profile>/` | `bootstrap!` 按 `profile` 选文件 |
//! | `log.toml` | `target/<profile>/log.toml` | 日志初始化 |
//! | `migrations/` 整目录 | `target/<profile>/migrations/` | `db_migrate!` 按库类型执行 |
//! | `cert/` 整目录（有才拷） | `target/<profile>/cert/` | TLS 证书 |
//!
//! 为什么要它：`OUT_DIR` 是 `target/<profile>/build/<pkg>-<hash>/out`，往上第三级
//! 正好是可执行文件所在目录。不这么做，`cargo run` 读到的是源码目录，
//! 而容器里镜像只带了二进制 —— 同一份代码两种行为，排查起来最费时间。
//!
//! 新增一类运行期资源时，改这里而不是在代码里写相对路径。

use std::fs;
use std::path::Path;

fn main() {
    let project_root = env!("CARGO_MANIFEST_DIR");
    let out_dir = std::env::var("OUT_DIR").expect("缺少 OUT_DIR：这不是 cargo 触发的构建");
    // target/<profile>/build/<pkg>-<hash>/out → target/<profile>
    let dest_dir_path = Path::new(&out_dir)
        .ancestors()
        .nth(3)
        .expect("OUT_DIR 层级不符合预期");

    const CONFIG_EXTS: &[&str] = &["toml", "json", "json5", "yml", "yaml", "ini", "ron"];

    let pkg_name = env!("CARGO_PKG_NAME");

    // 一份配置四个环境：不带后缀的是默认值，带后缀的覆盖它
    for suffix in ["", "-dev", "-test", "-prod"] {
        let file_name = format!("{pkg_name}{suffix}");
        for ext in CONFIG_EXTS {
            copy_file(project_root, &file_name, ext, dest_dir_path);
        }
    }

    for ext in CONFIG_EXTS {
        copy_file(project_root, "log", ext, dest_dir_path);
    }

    copy_dir(project_root, "migrations", dest_dir_path);
    copy_dir(project_root, "cert", dest_dir_path);
}
/// 整目录复制。源目录不存在就跳过：`cert/` 在很多服务里是可选的。
fn copy_dir(project_root: &str, src_dir: &str, dest_dir_path: &Path) {
    let src_dir_path = Path::new(project_root).join(src_dir);
    if !src_dir_path.is_dir() {
        return;
    }
    // 必须发 rerun-if-changed：build.rs 只要给任何一个文件发过它，cargo 的
    // 「整包变化就重跑」默认行为就关了 —— 改了 migrations 里的 SQL 不会重新拷贝，
    // 二进制旁边一直是旧脚本，联调 / 部署建出来的表永远少一张。
    println!("cargo:rerun-if-changed={}", src_dir_path.display());
    copy_dir_recursive(&src_dir_path, &dest_dir_path.join(src_dir));
}

fn copy_dir_recursive(src: &Path, dest: &Path) {
    fs::create_dir_all(dest).ok();
    if let Ok(entries) = fs::read_dir(src) {
        for entry in entries.flatten() {
            let src_path = entry.path();
            let dest_path = dest.join(entry.file_name());
            if src_path.is_dir() {
                copy_dir_recursive(&src_path, &dest_path);
            } else {
                // 复制失败不 panic：迁移目录里可能只有 .gitkeep，权限问题也不该挡住编译
                fs::copy(&src_path, &dest_path).ok();
            }
        }
    }
}

fn copy_file(project_root: &str, file_name: &str, ext: &str, dest_dir_path: &Path) {
    let src_path = Path::new(project_root).join(format!("{file_name}.{ext}"));
    if !src_path.exists() {
        return;
    }
    // 让 cargo 在配置变化时重跑本脚本，否则改了 toml 要手动 touch 才生效
    println!("cargo:rerun-if-changed={}", src_path.display());
    let dest_path = dest_dir_path.join(format!("{file_name}.{ext}"));
    fs::copy(&src_path, &dest_path).ok();
}
