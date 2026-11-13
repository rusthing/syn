//! # 数据源连接清单
//!
//! 连接串只在 `[syn.datasources.*]`（本地 toml / consul KV）里维护，控制台**不能**
//! 增删改：能改连接串就等于能改「写哪个库」，那是部署配置不是业务配置。
//!
//! 但控制台必须能列出名字，否则 `spec.datasource` 靠手填，拼错一个字母要等
//! `立即拉取` 报 `DB_DATASOURCE_NOT_FOUND` 才发现。这个接口把「可选值」交给界面。

use anyhow::anyhow;
use robotech::svc::SvcError;
use syn_api::SynDatasourceVo;

use crate::config::get_app_config;

pub struct SynDatasourceSvc;

impl SynDatasourceSvc {
    /// # 列出当前进程实际生效的数据源
    ///
    /// 读的是运行时配置（已叠过配置中心），不是磁盘上的 toml —— 热更新后
    /// 界面看到的新名字必须和 `DbSinks::pool_for` 认的名字一致。
    pub fn list() -> Result<Vec<SynDatasourceVo>, SvcError> {
        let cfg = get_app_config()
            .map_err(|e| SvcError::Runtime(anyhow!("读取应用配置失败：{e}")))?;
        let mut rows: Vec<SynDatasourceVo> = cfg
            .syn
            .datasources
            .iter()
            .map(|(name, c)| SynDatasourceVo {
                name: name.clone(),
                target: mask_url(&c.url),
                max_connections: c.max_connections,
            })
            .collect();
        rows.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(rows)
    }
}

/// # 连接串脱敏
///
/// 只保留 `user_info@` 之后、query 之前的部分。`postgres://u:p@host:5432/db?sslmode=disable`
/// → `host:5432/db`。解析不出 `@` 时（比如 unix socket 形态）返回 null，不猜也不外泄。
fn mask_url(url: &str) -> Option<String> {
    let after_user = url.split_once('@')?.1;
    let target = after_user.split(['?', '#']).next().unwrap_or(after_user).trim();
    (!target.is_empty()).then(|| target.to_string())
}

#[cfg(test)]
mod tests {
    use super::mask_url;

    #[test]
    fn masks_credentials_and_query() {
        assert_eq!(
            mask_url("postgresql://syn:secret@pgsql:5432/dtwrs_ui?sslmode=disable"),
            Some("pgsql:5432/dtwrs_ui".to_string())
        );
    }

    #[test]
    fn no_credentials_means_no_hint() {
        assert_eq!(mask_url("postgresql:///syn?host=/var/run/postgresql"), None);
    }
}
