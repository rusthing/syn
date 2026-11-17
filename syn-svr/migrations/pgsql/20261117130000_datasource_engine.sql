/* 数据源补引擎列：多驱动（PostgreSQL / MySQL / SQLite）按 engine 选方言与连接池。
 *
 * 多驱动改造把 engine 直接写进了首建表 DDL（见 20261112000000），但存量库是
 * 旧版 DDL 建的、没有这条 ALTER，升级后代码 SELECT engine 直接撞 42703 缺列。
 * 这份增量迁移给存量库补上同一列；新库首建表已含 engine，ADD COLUMN IF NOT
 * EXISTS 在这里是空操作。
 *
 * engine：0=PostgreSQL（默认），1=MySQL，2=SQLite。 */

alter table syn_datasource add column if not exists engine INT2 not null default 0;

-- 存量行按连接串 scheme 回填引擎；库里存的 engine 是运行时选方言/驱动的依据，
-- 不做 scheme 推断，所以这里必须一次填对。
update syn_datasource set engine = case
    when url like 'mysql://%' or url like 'mariadb://%' then 1
    when url like 'sqlite%' then 2
    else 0
end;
