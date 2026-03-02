# IG 2FA Manager v2.0

Terminal UI để quản lý và chạy nhiều luồng Instagram 2FA tự động.

## CẤU TRÚC THƯ MỤC

```
ig-manager/
├── manager.js          ← Terminal UI chính
├── worker.js           ← Worker process (mỗi thread = 1 worker)
├── package.json
├── manager_config.json ← Được tạo tự động khi chạy lần đầu
└── data/
    ├── thread1/
    │   ├── input.txt       ← Danh sách account cần xử lý
    │   ├── hotmail.txt     ← Danh sách hotmail (optional)
    │   ├── success.txt     ← Kết quả thành công (tự động tạo)
    │   ├── failed.txt      ← Kết quả thất bại (tự động tạo)
    │   ├── screenshots/    ← Ảnh chụp lỗi
    │   └── worker_config.json ← Config worker (tự động tạo)
    ├── thread2/
    │   └── ...
    └── threadN/
        └── ...
```

## CÀI ĐẶT

```bash
# 1. Cài dependencies
npm install

# 2. Cài Playwright Chromium (QUAN TRỌNG - thay vì dùng puppeteer)
npx playwright install chromium

# 3. Chạy
node manager.js
```

## TẠI SAO DÙNG PLAYWRIGHT THAY PUPPETEER?

| Tính năng         | Puppeteer     | Playwright                    |
| ----------------- | ------------- | ----------------------------- |
| Bundle browser    | Khó với pkg   | `npx playwright install` — dễ |
| Multi-context     | Browser level | Context level (nhanh hơn)     |
| Cookie import     | setCookie     | addCookies                    |
| Proxy per context | Không         | Có                            |
| Reliability       | Tốt           | Tốt hơn                       |

Playwright download browser vào `~/.cache/ms-playwright/` → không cần bundle vào exe.
Khi chạy trên máy mới chỉ cần `npx playwright install chromium` là xong.

## FORMAT FILE INPUT.TXT

```
username|password|ig_email|gmx_mail|gmx_password|yop_mail|posts|followers|following|cookies_json
```

Ví dụ:

```
myuser|mypass123|myuser@gmail.com|backup@gmx.net|gmxpass|yop@yopmail.com|100|500|300|[{"name":"sessionid",...}]
```

## FORMAT FILE HOTMAIL.TXT

```
email@hotmail.com|password|refresh_token|client_id
```

## ĐIỀU KHIỂN TERMINAL UI

| Phím  | Hành động                                      |
| ----- | ---------------------------------------------- |
| `N`   | Tạo thread mới                                 |
| `D`   | Xóa thread đang chọn                           |
| `S`   | Start thread đang chọn                         |
| `X`   | Stop thread đang chọn                          |
| `A`   | Start tất cả threads                           |
| `Z`   | Stop tất cả threads                            |
| `E`   | Chỉnh config thread                            |
| `G`   | Chỉnh global config (Chrome path, max threads) |
| `↑↓`  | Chọn thread                                    |
| `Tab` | Chuyển focus giữa các panel                    |
| `Q`   | Thoát                                          |

## CONFIG CHROME PATH

Khi chạy lần đầu, manager tự detect Chrome/Edge. Nếu không tìm thấy:

1. Nhấn `G` để mở Global Config
2. Nhập đường dẫn vào `Chrome/Edge Executable Path`

Ví dụ đường dẫn:

- Windows: `C:\Program Files\Google\Chrome\Application\chrome.exe`
- macOS: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
- Linux: `/usr/bin/google-chrome`

Hoặc dùng Playwright's built-in Chromium (sau khi `npx playwright install chromium`):

- Windows: `%LOCALAPPDATA%\ms-playwright\chromium-xxxx\chrome-win\chrome.exe`
- Để trống → Playwright tự dùng built-in Chromium

## CHẠY NHIỀU LUỒNG

1. Nhấn `N` nhiều lần để tạo các threads
2. Nhấn `E` trên từng thread để cấu hình:
   - `dataDir`: Thư mục data riêng (ví dụ: `data/thread1`, `data/thread2`)
   - Proxy settings nếu cần
   - Delays, retries, etc.
3. Đặt file `input.txt` và `hotmail.txt` vào từng thư mục
4. Nhấn `A` để start tất cả

## LƯU Ý QUAN TRỌNG

- Mỗi thread dùng thư mục data riêng → không đụng nhau
- Config được save vào `manager_config.json` sau mỗi lần chỉnh
- Log của từng thread hiển thị riêng khi chọn thread đó
- Max concurrent threads mặc định là 5, tối đa 20
- Khi stop thread, account đang xử lý có thể bị mất → restart sẽ skip account đã done
