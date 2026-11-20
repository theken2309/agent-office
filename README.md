# Agent Office

Cửa sổ văn phòng pixel hiện các agent Claude Code đang chạy trên máy — mọi session (app desktop, terminal, VS Code), kể cả subagent.

- **Văn phòng**: agent đang làm ngồi bàn (màn hình sáng khi chạy tool), agent cần bạn giơ "!" vàng, agent rỗi/xong ra sofa. Biển WORK / WAIT / REST đếm số người; chồng giấy trên quầy lễ tân = số việc trong hàng chờ.
- **Tab**: Tất cả · Cần bạn · Đang làm · Rỗi · Quy trình · Hàng chờ · Đội. Tiêu đề cửa sổ hiện số agent đang chờ bạn, vd. `(2) Agent Office`.
- **Click** vào nhân vật, dòng agent hoặc nút "Mở chat ↗" → mở đúng chat trong app Claude. Session chạy ở terminal → copy lệnh `claude --resume <id>`.
- **Nút "Xong ✓"** (chỉ khi phiên rỗi): ẩn phiên cho đỡ rối — ẩn cả nhân vật, subagent, số đếm. Phiên có hoạt động mới (bạn nhắn tiếp, agent chạy lại) thì tự hiện lại. Xem / hiện lại ở mục "Đã ẩn" cuối tab Tất cả và Rỗi. Chỉ ẩn trong Agent Office, không đụng tới app Claude.
- **Rê chuột**: thẻ thông tin (tool đang chạy, việc hiện tại, bước quy trình, tác vụ được giao…).
- **🔔**: menu thông báo — bật/tắt chung và từng loại (xem mục Thông báo). Nút "Thử thông báo" để kiểm kênh đang dùng.

## Quy trình nhiều agent

Phiên gọi các agent khai báo trong [`pipelines.json`](pipelines.json) (mặc định: planner → *Duyệt Plan* → ui-designer → *Duyệt UI spec* → coder → tester, tối đa 2 vòng) hiện thành **dải bước** trong thẻ phiên, ví dụ `#1389 ✓ Planner › ✓ Duyệt Plan › ✓ UI designer › ✓ Duyệt UI spec › ✓ Coder › ✓ Tester 15✓ 1✗`. Bấm dải bước → tab **Quy trình** xem chi tiết: ai làm, bao lâu, tóm tắt báo cáo, kết quả PASS/FAIL của tester, câu hỏi duyệt và câu bạn đã trả lời.

- **Mã ticket**: từ file `.workspace/tickets/ticket_<id>.md` mà agent đụng tới, hoặc chữ "ticket 1234" trong prompt.
- **Cổng duyệt**: câu hỏi cuối lượt (wrap_up / AskUserQuestion) giữa lúc bước xong và lúc bước sau bắt đầu; ưu tiên câu khớp `gate.match`. Chưa trả lời → ô vàng "chờ bạn".
- **PASS / FAIL**: đếm con số đầu tiên trước chữ `PASS`, `FAIL`, `NOT RUN` trong báo cáo cuối của tester. Tester viết khác mẫu thì chỉ hiện "xong".
- Phiên không khớp quy trình nào nhưng gọi từ 2 subagent trở lên → hiện **chuỗi agent** theo thứ tự chạy. Phiên chạy **Workflow** → hiện tên, phase, số agent xong/tổng (phase chi tiết có khi Workflow ghi xong file kết quả).
- Sửa `pipelines.json` rồi lưu, server tự đọc lại sau ~20 giây (sai cú pháp thì giữ bản cũ, xem log).

## Thông báo

Server quyết định khi nào báo (gom các sự kiện cùng phiên trong 2,5 giây thành một), rồi:

- **Bong bóng** (`Agent Bubble.app`) hiện **thông báo macOS thật** — đóng cửa sổ lớn vẫn nhận. Lần đầu macOS hỏi quyền, bấm *Cho phép* (đổi sau ở Cài đặt hệ thống › Thông báo › Agent Bubble). Bấm thông báo → mở đúng chat.
- Bong bóng không chạy / chưa được phép → **cửa sổ Chrome** báo thay (cần cho phép trong menu 🔔).

| Loại | Mặc định | Khi nào |
| --- | --- | --- |
| Cần bạn / chờ duyệt | bật | phiên hoặc agent hỏi bạn; nếu đang ở cổng duyệt thì tiêu đề là `❗ Duyệt Plan · #1389` |
| Phiên xong lượt | bật | đang làm → rỗi |
| Bước quy trình xong | bật | planner/ui-designer/coder/tester xong hoặc bị dừng (`❌ Tester xong · 5 PASS · 1 FAIL · vòng 1/2`), Workflow xong |
| Có thể đang treo | bật | đang chạy tool mà log im quá 15 phút |
| Subagent lẻ xong | **tắt** | Explore, general-purpose… (không thuộc quy trình) |

Cài đặt lưu ở `~/.agent-office/settings.json`, danh sách phiên đã ẩn ở `~/.agent-office/hidden.json`.

Không cần cài gì thêm ngoài Node 18+. Dữ liệu lấy từ log `~/.claude/projects/**.jsonl` và danh sách session của app Claude (`~/Library/Application Support/Claude/claude-code-sessions`). Server chỉ nghe trên `127.0.0.1`.

## Dùng

- Bấm biểu tượng **Agent Office** trên Dock (app ở `~/Applications/Agent Office.app`), bấm đúp **`Agent Office.command`** trong Finder, hoặc chạy `./open.sh`: bật server (nếu chưa chạy) và mở cửa sổ riêng.
- **Bong bóng nổi** (`~/Applications/Agent Bubble.app`): luôn nằm trên mọi cửa sổ, ở mọi Desktop, và là kênh **thông báo macOS**. Viền xanh quay = có agent đang làm, viền vàng nhấp nháy + "!" = có agent cần bạn, viền xanh lá + "z" = rỗi; số cam = cần bạn, số xanh = đang làm. Kéo để di chuyển (tự dính mép), bấm để bung/thu văn phòng nhỏ, chuột phải để có menu (mở cửa sổ lớn, tải lại, tắt bong bóng). Build lại: `./make-bubble.sh` (kèm tự bật khi đăng nhập) hoặc `./make-bubble.sh --no-autostart`.
- `./make-app.sh`: tạo lại `Agent Office.app` (icon pixel) và ghim lên Dock nếu chưa có (`--no-dock` để chỉ tạo app). Icon vẽ trong `tools/make-icon.mjs`.
- `./install-autostart.sh`: tự bật khi đăng nhập (server chạy nền + mở cửa sổ). Gỡ: `./uninstall-autostart.sh`.
- `./stop.sh`: tắt server.
- Log server: `~/.agent-office/server.log`.
- Sửa code xong: `launchctl kickstart -k gui/$(id -u)/local.agent-office.server` — cửa sổ tự tải lại.

## Tuỳ chỉnh (biến môi trường)

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `PORT` | `47321` | Cổng server |
| `ACTIVE_MINUTES` | `30` | Hiện session có hoạt động trong N phút gần nhất |

## Trạng thái suy từ log

| Trạng thái | Khi nào |
| --- | --- |
| Đang làm | có tool chưa trả kết quả (⌨️) hoặc đang chờ model trả lời (💭) |
| Cần bạn | đang hỏi (AskUserQuestion), chờ duyệt kế hoạch (ExitPlanMode), hoặc lượt kết thúc bằng một câu hỏi |
| Rỗi | lượt đã xong, không hỏi gì; hoặc bị ngắt |
| Subagent xong | `meta.json` có `finished: true` / agent đã nộp báo cáo; ngồi sofa 10 phút rồi biến mất |

- **Hàng chờ** = tin nhắn bạn gửi đang xếp hàng (`queue-operation`) + việc chưa xong trong danh sách việc của từng agent (`update_plan`, `TodoWrite`, `TaskCreate`).
- **Đội** = agent định nghĩa trong `~/.claude/agents` và `.claude/agents` của các project đang mở, cộng agent có sẵn; "Rỗi" khi không có bản nào đang chạy.
- Log im quá 15 phút khi đang "làm" → coi như không hoạt động. Trạng thái trễ khoảng 0.5–1 giây.
