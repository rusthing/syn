//! # 总览 DTO

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// # 总览的时间窗
#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
#[serde(default, rename_all = "camelCase")]
pub struct SynOverviewQueryDto {
    /// 统计窗口，`1h` / `6h` / `24h` / `7d`，缺省 `24h`
    pub window: Option<String>,
}

impl SynOverviewQueryDto {
    /// 窗口长度（毫秒）。认不出来就按 24h，不报错：总览页不该因为拼错一个参数白屏
    pub fn window_ms(&self) -> i64 {
        match self.window.as_deref().unwrap_or("24h") {
            "1h" => 3_600_000,
            "6h" => 6 * 3_600_000,
            "7d" => 7 * 24 * 3_600_000,
            _ => 24 * 3_600_000,
        }
    }

    /// 回显用的窗口名
    pub fn window(&self) -> &str {
        self.window.as_deref().unwrap_or("24h")
    }
}
