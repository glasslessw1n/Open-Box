# traffic-guard —— 节点流量耗尽自动切换（Open-Box 附加组件）

给 Open-Box 补一层它目前没有的检测：**节点“还能连”不等于“还能用”**。

订阅节点在流量耗尽或被限速后，常见表现是：连接照常建立、延时照常好看、测速小请求照常通过——但一跑真实流量，服务商要么返回一张 HTML 限流提示页，要么直接零吞吐。Open-Box 自带的 url-test / 故障转移按连通性、延时和状态码判断，会把这种节点当作健康节点继续使用。节点名字（节点 1、节点 2……）又看不出谁耗尽了，所以只能靠**真实流量探测**来区分。

traffic-guard 就是做这件事的守护程序：

1. **盯住现状**：每轮巡检（默认 120 秒）对每个 selector 组当前选中的节点开一条临时探测通道（用 Open-Box 自带的 sing-box 内核，只读它生成的 `config.json` 里该节点的参数），发一个小请求（`generate_204`）。返回的不是干净的 204（限流页、其它状态码、超时、断流）即判失败。
2. **触发切换**：同一节点连续失败达到阈值（默认 2 次）后，扫描该组全部候选节点：先小请求筛掉死节点，再**真下载一段数据**（默认 256KB）验证吞吐——下载量不足、平均速度低于门槛（默认 20KB/s）、或响应是 HTML 限流页的，都算不可用。
3. **按延时择优**：在可用节点里选实测延时最低的，通过内核 Clash API 切换该组的选择——与在面板里手动点选完全等效，不重启内核、不断其它连接。
4. **防抖与自愈**：切换有冷却时间（默认 300 秒）；被判耗尽的节点进黑名单（默认 1800 秒），到期后自动重新参与候选——机场按月/按日重置流量后节点能自己回来；全部候选都不可用时保持现状，只记日志，绝不乱切。
5. **兜底复检**：每 6 小时（可配）对当前节点强制做一次真实下载验证，防止“小请求能过、大流量不行”的漏网情况。

## 与 Open-Box 本体的关系

- **独立附加组件，不是 Open-Box 官方功能**，不修改 Open-Box 的任何文件；
- 只读 `/opt/open-box/etc/config.json`，只调用内核 Clash API（默认 9095），程序与状态都放在 `/opt/openbox-traffic-guard/`；
- Open-Box 升级只保留它自己的 `data/` 与 `etc/`，不会动本组件；本组件也不影响升级；
- url-test 组、故障转移（fallback）组由 Open-Box 自己管理，本组件**只守护手动选择（selector）组**，互不干涉。

## 安装

在路由器 / 主机上（root）：

```sh
cd addons/traffic-guard
sh install-addon.sh
```

安装脚本会把程序装到 `/opt/openbox-traffic-guard/`，并按平台注册服务：OpenWrt 用 procd（`openbox-traffic-guard`），Debian/Ubuntu 用 systemd（`traffic-guard`），Docker 环境只装文件并打印手动启动命令。重复运行安装脚本是安全的：已有配置和状态会被保留。

Docker 部署时也可以把本目录挂进容器后手动常驻运行：`/opt/openbox-traffic-guard/traffic-guard run`。

## 配置

配置文件 `/opt/openbox-traffic-guard/traffic-guard.conf`（shell 语法，改后重启服务生效），常用项：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `CHECK_INTERVAL` | 120 | 巡检间隔（秒） |
| `FAIL_STREAK` | 2 | 当前节点连续失败几次才触发切换 |
| `SWITCH_COOLDOWN` | 300 | 同一组两次切换的最小间隔（秒） |
| `BLACKLIST_TTL` | 1800 | 耗尽节点在黑名单停留时间（秒），到期复测 |
| `FULL_SCAN_INTERVAL` | 21600 | 兜底全量复检间隔（秒，0=关） |
| `MIN_BYTES` / `MIN_SPEED_BPS` | 200000 / 20480 | 真实下载验证的达标线（字节 / 字节每秒） |
| `MANAGED_GROUPS` | 空 | 只守护这些 selector 组（逗号分隔）；留空=全部 |
| `EXCLUDE_GROUPS` | 空 | 永不守护的组（优先于上一项）。用途固定的组建议放这里 |
| `LIMIT_MARKERS` | 空 | 限流页特征词（逗号分隔，可选），命中小体积响应即判限流页 |

## 常用命令

```sh
/opt/openbox-traffic-guard/traffic-guard status        # 黑名单、最近切换、日志
/opt/openbox-traffic-guard/traffic-guard once          # 立即巡检一轮
/opt/openbox-traffic-guard/traffic-guard probe '节点名' full   # 手动测某个节点（小请求+真实下载）
```

日志在 `/opt/openbox-traffic-guard/state/traffic-guard.log`，同时发往 syslog（tag `openbox-traffic-guard`）。

## 卸载

```sh
sh uninstall-addon.sh          # 停服务、删程序，保留配置与日志
sh uninstall-addon.sh --purge  # 连配置与状态一并删除
```

## 已知边界

- 探测会消耗少量流量：巡检只有小请求可忽略；触发扫描时每个候选约 256KB。
- 探测目标默认用 gstatic 的 204 端点与 Cloudflare 测速端点；若你的分流策略让这些域名走了特殊路径，可在配置里换成其它稳定地址。
- 若某节点在小请求层面完全透明、只对特定业务限速，本组件以“通用下载”为准绳，无法识别单个应用维度的限速。
- 链式代理（detour）与以节点组为前置的节点会被完整克隆依赖后再探测；WireGuard 端点同样支持。

## 测试

`tests/run-tests.sh` 用官方 sing-box 内核 + 假节点（限流页 / 黑洞 / 限速 5KB/s / 高延时 / 健康五种）在本机跑端到端场景：耗尽节点应被换到延时最低的健康节点、全灭组应保持不动、健康现状不应被打扰。已在 sing-box 1.14.4 上全部通过。运行需要 node、curl 与联网下载测试用 sing-box 二进制。
