# Enterprise P1 Plan — 多租户深化 · 软删除/回收站 · 引用权限校验 · 无状态化

> Status: 方案已确认（Q1=owner 隔离，Q2=永久保留，Q3=引入 Redis（本机已有），Q4=Milvus）—— 按依赖顺序实施中
> Predecessor: docs/design/enterprise-p0-plan.md（workspace 级 RBAC/审计/锁/实例回收/健康探针，已收尾）

## 0. 目标与边界

四项改造，覆盖前端 + 后端 + 数据库，与 P0 的 RBAC/审计/锁模型直接衔接：

1. 多租户隔离深化 —— 从"workspace 目录 + 授权行"升级为"workspace 元数据 + 文档所有权"。
2. 软删除 + 回收站 —— 替换现在的物理删除（`adelete_by_doc_id` purge 路径），恢复低成本、彻底清除独立端点。
3. 回答引用文档时校验当前用户访问权限 —— 防越权泄露（软删除文档的引用、无权文档的引用一律不下发）。
4. 数据层下沉（PG + Redis + Qdrant/Milvus）→ API 无状态化 —— 实例按 header 路由、每请求轻量构造，进程内缓存仅为性能优化。

边界：不改动 LightRAG 核心检索/入库算法语义；所有行为变更默认在 `RBAC_ENFORCE=true` 时生效，`false` 保持现状（兼容既有部署）。

---

## 1. 多租户隔离深化

### 1.1 现状（P0 已建立）

- 租户粒度 = workspace：目录隔离（`working_dir/<name>` + `input_dir/<name>`）、授权行（`LIGHTRAG_WORKSPACE_PERMISSIONS`）、请求路由（`LIGHTRAG-WORKSPACE` header）。
- workspace 列表由 `WorkspaceManager.list_workspaces` **目录扫描** + 内存实例 + RBAC 过滤合并产生 —— 无持久化元数据（谁建的、何时建、描述、状态）。

### 1.2 深化内容

**a. 新表 `LIGHTRAG_WORKSPACES`（幂等迁移，随 `_migrate_create_enterprise_tables`）**

```sql
CREATE TABLE IF NOT EXISTS LIGHTRAG_WORKSPACES (
    name         TEXT PRIMARY KEY,          -- '' 命名默认 workspace
    owner        TEXT REFERENCES LIGHTRAG_USERS(username),
    description  TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'archived')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON LIGHTRAG_WORKSPACES (owner);
```

- workspace 创建（`POST /workspaces`）时写入：owner = 当前 admin 用户名、description 可传。
- `GET /workspaces` 从 RBAC grants + 该表查询，**去掉目录扫描**（与无状态化 4.4 联动）。
- `DELETE /workspaces` 同步删行（CASCADE 到权限行已由 P0 处理，此处删元数据行）。
- 归档语义（`status='archived'`）：写操作（upload/texts/graph write）拒绝 409，读与查询放行。**低风险增量，放本项最后**。

**b. 文档所有权（uploader）**

- PG `LIGHTRAG_DOC_STATUS` 加列 `owner TEXT NULL`；JSON 存储后端写入 `metadata.owner`（兼容）。
- 上传/文本入库时从请求身份写入 `owner`（X-API-Key 记为 `service`）。
- `GET /documents` 列表项返回 `owner`（前端展示"上传者"列）。

**c. 前端**

- Workspace 管理（`SiteHeader` → 管理入口已有）扩展：新建/编辑 workspace 时填描述；列表显示 owner/status；归档/激活切换。
- 文档列表显示上传者。

---

## 2. 软删除 + 回收站

### 2.1 现状

- `DELETE /documents/delete_document` → `background_delete_documents` → `rag.adelete_by_doc_id`：purge KG 贡献（anchors/journal 四证明）、删 chunks/向量/LLM cache、删 doc_status 行、删文件。**不可逆**。
- `DELETE /documents`（clear）：drop 全部存储 + 删文件。**不可逆**。
- duplicate 判定、`/documents` 列表、status counts 均基于 doc_status 现存行。

### 2.2 改造

**a. doc_status 加列（幂等）**

```sql
ALTER TABLE LIGHTRAG_DOC_STATUS ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;
ALTER TABLE LIGHTRAG_DOC_STATUS ADD COLUMN IF NOT EXISTS deleted_by TEXT NULL;
```

JSON 存储后端：`metadata.deleted_at` / `metadata.deleted_by`（兼容字段）。

**b. `DELETE /documents/delete_document` 默认软删除**

- 新增 query/body 参数 `purge: bool = False`：
  - `purge=false`（默认）：仅标记 `deleted_at=now(), deleted_by=username`；**保留**向量/图/KV/文件/LLM cache → 恢复零成本。
  - `purge=true`：走现有 `background_delete_documents` 物理删除（保留原 destructive 槽协议）。
- 保留现有审计钩子（action=`document_delete`，detail 加 `purge` 标志）。

**c. 新端点（document_routes，`authorize_write` 保护）**

| 端点 | 方法 | 语义 |
| --- | --- | --- |
| `/documents/recycle_bin` | GET | 当前 workspace 软删文档分页列表（file_path、deleted_at、deleted_by、content_length），`authorize_read` 可看，恢复/清除需 `write` |
| `/documents/restore` | POST | body `{doc_ids}`：清 `deleted_at/deleted_by`，状态回 `processed`（数据全在，无需重入库）；幂等 |
| `/documents/purge` | DELETE | body `{doc_ids}`：对软删文档执行现有物理删除流程（复用 `background_delete_documents` + destructive 槽） |

- restore/purge 并发安全：restore 用普通锁（仅改状态行）；purge 复用 `_acquire_destructive_busy`。

**d. 列表/统计/duplicate 判定排除软删**

- `GET /documents`、status counts、`iter_new_files`（scan 新文件）等查询一律 `deleted_at IS NULL` 过滤（JSON 后端 `metadata.deleted_at` 不存在判定）。
- 软删文档重新上传同名文件：**视为新文档**（duplicate 判定跳过软删行）——恢复与重新上传并存时以先到为准。

**e. clear 语义（决策点 Q2）**

- 方案 A：clear 保持物理清空（回收站不清整个 workspace，需二次确认）。
- 方案 B：clear = 全部软删（整库进回收站，可整体恢复/清除）。

**f. 前端**

- 文档列表增加"回收站"入口（`DocumentManager.tsx`）：回收站视图（列表 + 恢复 + 彻底删除按钮，按钮按 `canWrite` 显隐）。
- 删除按钮默认软删（无确认或轻确认）；"彻底删除"在回收站内二次确认。

### 2.3 与引用的联动

软删文档的 chunk/图数据仍在向量库中，查询可能命中 → 由第 3 项引用过滤层统一剔除（`deleted_at IS NOT NULL` → 引用不下发）。

---

## 3. 回答引用文档时校验访问权限（防越权泄露）

### 3.1 现状

- `references` 由 `generate_reference_list_from_chunks` 生成：`[{reference_id, file_path}]`，**无 doc_id、无状态/权限过滤**。
- `chunks`（include_chunk_content 时）同样无过滤。
- file_path 反查文档：已有 `doc_status.resolve_doc_source_strict`（SourceUnique/SourceConflict 语义）可用。

### 3.2 改造

**a. 统一过滤层（query_routes，三入口共用）**

新增 `filter_references_by_access(request, rag, references, chunks)`：

1. 若 `RBAC_ENFORCE != true` 或 guest 模式：直接返回（无过滤）。
2. 收集 references/chunks 中的 file_path 集合。
3. 批量反查文档状态（`resolve_doc_source_strict`，一批一次；结果短 TTL 缓存 ~30s，键 `workspace:file_path` → `{status, doc_id, owner, deleted}`）。
4. 剔除：
   - 已软删除（`deleted_at` 非空）的文档引用；
   - 无权文档（按决策点 Q1 的可见性规则）。
5. 重排 reference_id（保持 1..N 连续），chunks 同步过滤。

**b. 可见性规则（决策点 Q1）**

- 规则 A（workspace 继承）：凡有该 workspace `read` 授权的用户，可见该 workspace 全部**未删除**文档的引用。过滤层只做"软删剔除"。
- 规则 B（owner 隔离）：文档 `owner` 非空且 ≠ 当前用户时，仅 admin / workspace `admin` grant 可见；其余只剔除。上传的私有文档默认可见性为 owner+admin。

**c. 生效面**

- `/query`、`/query/stream`、`/query/data` 三入口全部过过滤层（引用 + chunk content 同步过滤）。
- 过滤在返回前完成，不影响检索本身；参考编号连续重排，客户端契约不变。
- 性能：批量反查 + 30s TTL 缓存；文档量极大时 file_path 命中数受 `top_k/chunk_top_k` 天然限制。

---

## 4. 数据层下沉 → API 无状态化

### 4.1 现状（有状态点清单）

| 有状态点 | 现状 | 跨 worker 行为 |
| --- | --- | --- |
| LightRAG 实例 | `WorkspaceManager` 进程内 LRU（8 个 / 1800s idle） | 每 worker 各缓存，数据在各自目录/PG（目录型存储不共享） |
| RBAC 缓存 | 进程内 TTL 30s | 每 worker 各自，权限变更 30s 内不一致（可接受） |
| pipeline_status / ingress / 锁表 | `multiprocessing.Manager` dict（进程内） | **不共享** —— 多 worker 下扫描/入库状态互相不可见 |
| 分布式锁 | PG advisory（跨 worker OK）+ 本地降级 | ✅ 已跨 worker |
| 审计 | PG 表 | ✅ 已跨 worker |
| 存储后端 | 可配 PGKV/PGVector/PGStorage/PGDocStatus/Qdrant/Milvus/Redis | 配置决定 |

### 4.2 目标语义

- **数据全在共享存储**（PG 元数据/KV/图/文档状态 + Qdrant/Milvus 向量 + 可选 Redis 协调层）→ 任意 worker 可服务任意 workspace 请求。
- **进程内缓存纯性能优化**：实例、RBAC 缓存、反查缓存均可安全丢弃。
- **每请求轻量构造**：从 header（Authorization/X-API-Key/LIGHTRAG-WORKSPACE）解析身份与 workspace → 构造/复用实例。

### 4.3 改造点

**a. 实例策略（workspace_manager）**

- LRU 参数收紧：`WORKSPACE_MAX_INSTANCES` 语义改为"进程内性能缓存上限"，默认下调（如 8→4）；idle timeout 缩短（1800→300s）。
- 无状态语义：实例构造为**纯配置组装**（storage 全 PG/Qdrant 时 `initialize_storages` = 建连接 + 迁移检查，无大文件加载）；缓存丢失不影响正确性。
- 保留 `_is_pipeline_busy` fail-closed 与 reclaim 循环（防 evict 活跃 pipeline）。

**b. pipeline_status 跨 worker 一致（决策点 Q3）**

- 方案 A（引入 Redis）：pipeline_status/ingress/占位表 从进程内 Manager → Redis hash/pubsub（`redis_impl` 已有）。多 worker 真实共享，扫描互斥语义由 PG advisory 锁兜底。
- 方案 B（不引入 Redis）：pipeline_status 保持进程内 + 文档明确单 worker 部署边界（gunicorn `--workers 1`），多 worker 不承诺扫描一致性；或改用 PG 表承载（改造量大于 Redis 方案）。
- 推荐 A：与用户目标架构（"PG + Redis + ..."）一致，且 P0 锁/审计已在 PG，Redis 只承担协调缓存。

**c. RBAC / 反查缓存**

- 有 Redis：RBAC 权限缓存落 Redis（跨 worker 即时生效），TTL 保持 30s；无 Redis 降级进程内（现状）。
- 引用反查缓存同理（短 TTL，进程内即可，无 Redis 也成立）。

**d. list_workspaces 去目录扫描**

- 改为：默认 workspace + `LIGHTRAG_WORKSPACES` 表查询 + RBAC grants 过滤（多 worker 一致；不再读文件系统）。

**e. 前端**

- 无状态化对前端透明（header 按请求携带，已实现）；仅 Workspace 管理页增加元数据展示。

### 4.4 部署验证

- gunicorn 多 worker（`--workers N`）下：登录/查询/上传/扫描/软删/回收站/审计全链路；扫描并发 409 语义；pipeline_status 一致。

---

## 5. 依赖与实施顺序

```
DB 迁移（workspace 表 + doc_status 列）          [task #9]
  ├─→ 软删除/回收站（后端 + 前端）              [task #10]
  ├─→ 引用权限校验（依赖软删标记）              [task #11]
  └─→ 无状态化（实例策略 + list_workspaces）     [task #12]
         └─→ 测试 + 全量回归 + 文档回填          [task #13]
```

- 每步独立可验证：迁移幂等可重跑；软删不动 purge 路径；过滤层 RBAC_ENFORCE=false 零影响；无状态化默认参数向后兼容。
- 测试镜像布局：`tests/api/soft_delete/`、`tests/api/ref_filter/`、`tests/api/workspace_meta/`（沿用 P0 的 FakeDb/TestClient 模式 + argparse argv 保护）。

## 6. 风险与对策

| 风险 | 对策 |
| --- | --- |
| doc_status schema 变更破坏现有查询 | 幂等 ALTER + JSON 后端 metadata 兼容层；列表/统计统一过滤视图 |
| 软删与 purge 并发 | purge 复用 destructive 槽协议；restore 幂等 + 普通锁 |
| duplicate 判定误伤软删文档 | 判定查询加 `deleted_at IS NULL`；同名恢复与重传以先到为准 |
| 引用过滤性能 | 批量反查 + 30s TTL 缓存；命中数受 top_k 限制 |
| 多 worker pipeline_status 不一致 | 决策点 Q3（推荐 Redis 方案 A） |
| 前端回收站/权限 UI 回归 | 沿用 P0 的 rbac.ts helpers；tsc/lint/bun test 全量回归 |
| 既有测试契约破坏 | 默认参数/默认行为保持 RBAC_ENFORCE=false 与 purge=false 兼容 |

## 7. 决策点（已确认 2026-10-01）

- **Q1 文档可见性：owner 隔离**（第 3 项按规则 B 实施：私有文档仅 owner + admin/workspace-admin 可见引用，其余继承 workspace 授权）。
- **Q2 回收站：永久保留**（无 TTL 自动清除；手动 purge 才物理删除；clear 保持物理清空 + 前端二次确认）。
- **Q3 Redis：引入，本机已有**（pipeline_status/ingress 镜像 + RBAC 缓存下沉 Redis；无 Redis 时进程内降级）。
- **Q4 向量库：Milvus**（storage 配置模板按 Milvus 出具；本机无 Milvus 时测试与验证用 pgvector 兜底，交付含 Milvus 部署说明）。

## 8. 实施记录

- 2026-10-01：四项决策确认，开始 task #9（DB 迁移 + 存储下沉）。
- 2026-10-01（task #9 完成）：LIGHTRAG_WORKSPACES 建表（owner/status/description + idx_workspaces_owner）；workspace_meta.py（TTL30s 缓存 + PG 降级）；redis_client.py（进程级单例 + 降级）；config 6 个 Redis env；workspace_routes 增 owner/description/status + PATCH /workspaces/{name}；env.example 增 Enterprise P1 块。本机真实 Redis/Milvus 连通验证通过。
- 2026-10-01（task #10 完成）：DocStatus.DELETED + DocStatusStorage 抽象 include_deleted 参数；5 个 doc_status 后端（PG/JSON/Redis/Mongo/OpenSearch）分页/统计/查重同步软删语义（758 项存储回归通过）；document_routes 软删端点（DELETE 默认软删、purge=true 物理删、GET /recycle_bin、POST /restore、DELETE /purge）配套 7 项测试；前端 API 层 + DeleteDocumentsDialog（默认软删 + 永久删除开关）+ 新 RecycleBinDialog + DocumentManager 入口 + zh/en 文案；前端三件套 bun test 634+1(Windows grep 限制)/tsc/lint 通过。**软删实现取舍**：status=DELETED + metadata 标记（不新增 SQL 列，update_doc_status_fields 白名单已覆盖）；软删行释放 basename/不构成 content_hash 重复证据（已按此实现）。**顺带修复 3 个 P0 遗留前端测试基建缺陷**：lightrag-stream.test.ts 的进程级 axios mock 改可恢复 spyOn（原先污染后续所有 import lightrag.ts 的测试，17 个失败）；usePageRestoreGeneration CRLF 断言；credentialProbe Windows URL pathname bug（20 失败 → 1 Windows 平台限制）。
- 2026-10-01（task #11 完成）：owner 隔离。pipeline `doc_status_extra` 语义改为合并进 metadata（固定列后端 PG 只持久化文档列 + JSONB metadata）；upload/text/texts 端点提取当前账号并注入 metadata.owner（scan/SDK 无 owner=共享）；新建 reference_access.py（软删引用剔除 + owner 隔离 + reference_id 连续重排 + chunk reference_id 对齐，RBAC_ENFORCE=true 生效，doc_status 查询单次查询内缓存、fail-open）；query_routes 三入口（/query、/query/stream、/query/data）统一接入过滤。测试：tests/api/reference_access/ 13 项单元 + tests/api/routes/test_query_reference_filter.py 5 项 HTTP 集成，query/document 路由既有回归 322 passed（15 项失败中 12 项为测试桩签名补齐 owner、3 项 Windows 平台限制）。
- 2026-10-01（task #12 完成）：无状态化。
  - **实例策略收紧**：config.py `WORKSPACE_MAX_INSTANCES` 8→4、`WORKSPACE_IDLE_TIMEOUT_SECONDS` 1800→300，语义注释改为"进程内性能缓存上限"（数据全在 PG/向量库时实例是纯性能缓存，evict 后可重建）；workspace_manager.py 类默认值同步。
  - **RBAC 缓存下沉 Redis（Q3 落地）**：RBACManager 增可选 redis 层——get_user/get_permissions 进程内 TTL 缓存 miss 时先读 Redis（key `{prefix}rbac:user|perms:{username}`，TTL 30s），再 miss 才查 PG 并镜像回 Redis；invalidate 改为 async 并同时删 Redis key；get_rbac_manager(args) 接线 Redis（unreachable 降级进程内，行为与 P0 完全一致）。新增 tests/api/rbac/test_rbac_cache_redis.py 5 项（read-through/miss 不镜像/Redis 命中跳 PG/invalidate 删 key/无 Redis 降级），rbac 目录 27 passed。
  - **pipeline_status 跨 worker 决策（修正 §4.3b 方案 A）**：核查 `run_with_gunicorn.py` 后确认——`initialize_share_data(workers>1)` 在主进程用 multiprocessing.Manager 创建共享 dict，gunicorn fork 后 worker 继承代理连接同一 Manager 服务，**pipeline_status/ingress/占位表已天然跨 worker 一致**。故不实施 Redis 镜像（无正确性收益，仅增复杂度）；redis_client 保留用于 RBAC 缓存与未来协调增强。
  - **list_workspaces 去目录扫描**：task #9 已落地（workspace_meta.list_all() 合并），无额外改动。前端对无状态化透明。
  - **部署验证缺口**：gunicorn 多 worker 实测需 Linux（gunicorn 官方不支持 Windows fork，本机只能单 worker）；多 worker 全链路验证列入生产部署清单（§4.4），本机回归以单 worker + PG/Redis/Milvus 实栈为准。

- 2026-10-01（task #13 进行中）：真实栈（PG + Redis + Milvus）E2E 全链路验证 + 全量回归。
  - **E2E（e2e_p1_smoke.py，6 步全 PASS）**：探针（healthz/readyz）→ RBAC grant（viewer read default）→ 上传 e2e-owner.txt → processed 后 metadata.owner 保留 → viewer/admin 引用对比（viewer 引用无私有文档、回答正文无泄露原句；admin 可见私有引用）→ 软删/回收站/恢复/二次软删/purge（purge 后回收站清空）→ workspace 列表 + PATCH 元数据 + LIGHTRAG-WORKSPACE header 路由（default 的规范名为空串）。
  - **E2E 暴露并修复的真实缺陷（本段）**：
    1. 文档列表端点为 `POST /documents/paginated`（非 GET /documents）。
    2. text 上传返回 track_id，文档 id 需按 file_path 在列表定位；上传前清理残留（软删 + purge + 等 destructive_busy）。
    3. **owner 元数据丢失**：`_DOC_STATUS_METADATA_CARRY_OVER_KEYS` 白名单未含 `"owner"`，状态转换时私有文档 owner 消失 → 防越漏失效。已修（utils_pipeline.py）。
    4. **防越权泄露核心缺陷**：reference_access 过滤在 LLM 生成之后，viewer 回答正文仍引用私有内容。已修：QueryParam.access_filter + operate.py `_filter_chunks_for_access`（检索后、生成前过滤；Milvus 栈 doc_status 返回 tuple 兼容）+ naive/kg 缓存 key 追加 username/workspace + query_routes 三端点 `_build_access_filter`。实测 viewer 回答无泄露。
    5. 软删端点 `DELETE /documents/delete_document`（body doc_ids+purge）；purge 为后台任务需轮询回收站。
    6. **软删行误判 duplicate/静默丢弃（三处 PG 修复）**：`_PRIMARY_PREDICATE` 加 `status <> 'deleted'`；`PGDocStatusStorage.filter_keys` 加 `AND status <> 'deleted'`（软删行释放 basename 派生 id，重传同文件视为新工作）；`get_doc_by_file_basename`/`get_doc_by_content_hash` 本就排除 deleted 行（核实无需改）。
    7. **workspace_meta 的 ClientManager.get_client 签名冲突（ClientManager 进程级池的第四处遗漏）**：未传 vector_storage → 与 Milvus 主栈签名不兼容 → WorkspaceMeta 整体降级不可用（PATCH /workspaces 报 PG required）。已修：传 `os.environ.get("LIGHTRAG_VECTOR_STORAGE")`。
    8. default workspace 规范名为空串：header 路由验证须传 `LIGHTRAG-WORKSPACE: ""`（传 "default" 会 403）。
  - **隔离回归**：tests/api/reference_access（13）+ tests/api/routes/test_query_reference_filter.py（5）= 18 passed；tests/kg/postgres_impl/test_postgres_upsert.py 30 passed。
  - **全量回归（4 轮）**：首次 391 failed/8843 passed（含 setup/tools 平台类）；第二轮 73% 处中断未完成；第三轮 49 failed/8659 passed；修复全部真缺陷后第四轮 **41 failed/8667 passed/294 skipped/17 errors**（564s）。
    - **本轮修复的真缺陷（全量暴露）**：① `test_carry_over_keys_grouped_by_stage` 严格元组断言未含 owner（同步测试）；② login 3 项 + ai_content_notice 2 项——P0 后 login 优先 PG RBAC，本地 PG 残留 bootstrap 用户使测试桩失效（测试隔离 get_rbac_manager：auth / lightrag_server / utils_api 三处引用）；③ query_cache_user_prompt_prefix 2 项——P1 访问隔离把 username/workspace 无条件追加进回答缓存 key，导致无 access_filter 的请求缓存 key 漂移、旧缓存全部失效（改为仅在 access_filter 非空时追加，无过滤请求保持 P1 前 key）。
    - **剩余 41 failed + 17 errors 全为 Windows 平台限制（Linux CI 应通过）**：symlink/dir_fd/st_mode 0600（docx_archive、ui_customization、multimodal_path_containment）、特殊 code point 文件名（scan_unsafe_source）、gunicorn 多 worker/root_path（path_prefixes、gunicorn_worker_orphan_exit）、SIGKILL/pid 探测（keyed_holder_table、global_concurrency_slots、pipeline_ingress）、cairo DLL 缺失（parser/markdown SVG 5 项）、sidecar/mineru URI Windows 编码（sidecar_uri、parse_mineru_to_lightrag）、docstring_budget 路径分隔符、Windows env 32767 上限（user_prompt_prefix_env、tokenizer_split_truncate_contract 16 errors）。
  - **前端回归**：bun test 634 pass + 1 fail（Windows grep 平台限制，源码无真违规）；tsc --noEmit 0 错误；lint 0 错误。
  - **验证方式**：真实栈（PG localhost:5432/rag_db + Redis + Milvus 19530）单 worker E2E 六步全绿 + 后端全量 pytest + 前端三件套。多 worker 全链路仍需 Linux 生产环境（§4.4 部署清单）。
  - **遗留**：e2e_p1_smoke.py 保留为可重复 E2E 脚本（多次运行会清理同名残留文档）；E:\tmp_*.txt 为临时测试输出。

