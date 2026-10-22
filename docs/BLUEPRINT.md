# NightCut — Bản CapCut riêng, gọn nhẹ (Blueprint v1, 2026-10-23)

Mục tiêu: app edit video cá nhân thay phần CapCut phải trả phí hay dùng nhất
(cắt/ghép, chữ, phụ đề, nhạc, xuất TikTok/Reels/Shorts) — nhẹ, cài nhanh,
không cloud, không subscription. 

## 1. Vì sao CapCut mượt — 6 cơ chế cốt lõi

1. **Non-destructive editing:** project chỉ là file JSON mô tả clip/effect/
   transform. File gốc không bao giờ bị sửa hay re-encode cho tới lúc Export.
   Mọi thao tác trim/split/move chỉ sửa metadata → tức thì.
2. **Proxy media:** khi import, app âm thầm tạo bản proxy 540p/720p + cache.
   Lúc edit/scrub chỉ đụng proxy nhẹ; bản 4K gốc chỉ dùng khi export.
3. **Preview ≠ Export:** preview render ở độ phân giải canvas (thường ≤720p),
   giảm chất lượng effect, có frame-cache LRU + pre-render đoạn quanh playhead.
   Export mới render full-res một lần duy nhất.
4. **GPU + hardware decode/encode:** decode bằng VideoToolbox (macOS) /
   NVDEC+NVENC (NVIDIA) / QuickSync (Intel); các layer video/chữ/effect là
   GPU texture, composite bằng shader (Metal/Vulkan). CPU gần như không decode.
5. **Timeline UI không decode:** thumbnail là sprite-sheet tạo sẵn lúc import,
   waveform là peak-data tính sẵn theo mức zoom. Timeline chỉ vẽ phần đang
   nhìn thấy (virtualization). UI thread không bao giờ chạm vào video thật.
6. **Luồng riêng:** decode/render/audio chạy worker thread riêng, audio qua
   ring-buffer lock-free. Kéo timeline không block playback và ngược lại.

> Bài học: app nào decode 4K trực tiếp trên UI thread (kiểu Electron thuần)
> đều giật. Mượt = proxy + cache + GPU + tách luồng, không phải code khéo hơn.

## 2. Stack đề xuất (theo gu của Son: Rust tối ưu, nhẹ, không Python)

| Phần | Chọn | Lý do |
|---|---|---|
| Shell + UI | **Tauri 2 + React + TypeScript + Tailwind** | Cùng stack Boom, quen tay. Installer ~12–18MB so với Electron ~150MB+, RAM thấp |
| Timeline/Project model | **Rust — `editor-core`** | Thuần logic, test được, undo/redo bằng command stack |
| Media (probe/proxy/thumb/waveform) | **Rust — `media-engine`** | Gọi FFmpeg sidecar |
| Export | **Rust — `export-engine`** | Timeline → FFmpeg filter-graph → encode hardware |
| Preview (MVP) | **HTML5 `<video>` + overlay DOM/WebGL cho chữ/filter** | Dùng hardware decode có sẵn của WebView, ship nhanh, đủ mượt cho 1–2 layer |
| Preview (v2, khi cần nhiều layer) | **wgpu compositor trong Rust** | Chỉ làm khi MVP chứng minh cần — tránh code trang trí |
| FFmpeg | **Sidecar lazy-download lần chạy đầu** (mẫu zalo-bridge của Boom) | Installer không phình; không bắt user tự cài |
| Auto-caption (sau) | whisper.cpp model small, tải tuỳ chọn | Local, miễn phí, không cloud. Module tuỳ chọn, không bundle mặc định |

Không dùng: Electron, Python/PyInstaller, thư viện NLE có sẵn nặng nề.
Không làm: cloud template, kho nhạc bản quyền, AI trả phí của CapCut.

## 3. Cấu trúc thư mục (tối thiểu — module nào cũng nằm trên đường chạy thật)

```
nightcut/
├─ apps/
│  └─ desktop/                  # Tauri + React
│     ├─ src/
│     │  ├─ features/
│     │  │  ├─ editor/          # Timeline, Preview, Inspector, MediaBin
│     │  │  └─ export/          # Dialog export, preset 9:16 / 16:9 / 1:1
│     │  ├─ store/              # Zustand store: project state, selection
│     │  └─ App.tsx
│     └─ src-tauri/
│        └─ src/commands/       # import_media, make_proxy, export_video
├─ crates/
│  ├─ editor-core/              # Timeline model, project.json schema, undo/redo
│  ├─ media-engine/             # ffprobe, proxy, thumbnail sprite, waveform peaks
│  └─ export-engine/            # Timeline → filter-graph → FFmpeg encode (hw accel)
├─ tools/
│  └─ ffmpeg/                   # Chỉ chứa README + script tải binary; binary không commit
└─ BLUEPRINT.md
```

Quy tắc: không tách thêm crate (audio/effects riêng) cho tới khi code thật
cần. Audio/effect giai đoạn đầu nằm trong `export-engine` / filter-graph.

## 4. Project file (non-destructive)

```jsonc
{
  "version": 1,
  "canvas": { "w": 1080, "h": 1920, "fps": 30 },
  "tracks": [
    { "kind": "video", "clips": [
      { "src": "a.mp4", "proxy": ".cache/a.proxy.mp4",
        "in": 1.2, "out": 8.5, "timelineStart": 0, "speed": 1.0 }
    ]},
    { "kind": "audio", "clips": [ /* nhạc nền, volume, fade */ ] },
    { "kind": "text",  "clips": [ /* chữ + phụ đề, style, keyframe cơ bản */ ] }
  ]
}
```

## 5. Roadmap MVP — làm đúng thứ còn thiếu thật, theo thứ tự

- **Phase 0 — khung chạy được:** Tauri skeleton + import 1 video → preview
  phát được → timeline 1 track, trim/split/move → Export MP4 bằng FFmpeg.
  Xong phase này là đã thay được 50% việc hay dùng trên CapCut.
- **Phase 1 — dùng hằng ngày được:** nhiều track (video/audio/text), chữ +
  import .srt, nhạc nền + volume/fade, speed, crop preset 9:16/16:9/1:1,
  transition fade/dissolve (xfade), undo/redo đầy đủ.
- **Phase 2 — độ mượt:** proxy tự động, cache thumbnail/waveform, timeline
  virtualization, pre-render quanh playhead. Đây là phase biến app từ
  "chạy được" thành "mượt như CapCut".
- **Phase 3 — nâng cao (chỉ khi cần thật):** auto-caption whisper.cpp,
  LUT/filter, keyframe transform, template JSON chia sẻ được, wgpu compositor.

## 6. UI (theo design search: Short Video Editor → Dark OLED + timeline accent)

- Dark #121212/#1a1a1a giống gu Boom, preview ở giữa, MediaBin trái,
  Inspector phải, Timeline dưới — đúng layout CapCut Desktop/Premiere.
- Timeline: track có màu accent riêng, clip bo góc, waveform + filmstrip
  hiện sẵn từ cache (không load khi scroll).
- Mọi thao tác drag đều có thay thế bằng phím/nút (a11y + độ chính xác frame).

## 7. Kích thước mục tiêu

- Installer (chưa FFmpeg): 12–18MB · FFmpeg sidecar tải lần đầu: ~30MB
- RAM khi edit proxy 720p: mục tiêu < 600MB · Khởi động: < 1.5s

## 8. Vì sao không copy 100% CapCut — bản đồ parity

CapCut là mã đóng: không có source để copy, mọi bản "giống hệt" đều phải
tự viết lại từ đầu (clean-room clone). Phần nhìn thấy (editor) chỉ là phần
nổi — phần chìm là hạ tầng ByteDance chạy nhiều năm với đội ngũ rất lớn.

| Nhóm tính năng | Copy 1:1 được? | Ghi chú |
|---|---|---|
| Layout, timeline, trim/split, phím tắt, workflow | ✅ Được | Học pattern UX, tự vẽ/code lại — như Boom học Grokbot |
| Effect/transition/filter cơ bản, chữ, sticker tự tạo | ✅ Được | Viết bằng shader/FFmpeg filter, làm dần theo nhu cầu |
| Auto-caption, xoá nền, noise reduce | ⚠️ Được, bản local | Thay cloud AI bằng whisper.cpp / model local tải tuỳ chọn; chậm/nặng hơn cloud, không bundle mặc định |
| Kho template triệu mẫu, kho nhạc/effect store | ❌ Không có để copy | Là nội dung có bản quyền + do cộng đồng CapCut tải lên + chạy trên server của họ; tự làm chỉ có template mình tự tạo |
| AI cloud (script→video, avatar AI, enhance server) | ❌ Không | Phụ thuộc model + GPU server ByteDance, không nằm trong app |
| Đồng bộ cloud, tài khoản, trả phí, team collab | ❌ Không đáng | Cần dựng cả backend riêng; thừa với nhu cầu dùng cá nhân |
| Tên/logo/asset/font/nhạc mẫu của CapCut | ❌ Không dùng | Sở hữu trí tuệ của ByteDance/đối tác cấp phép — dùng riêng kín vẫn là tài sản của họ, phát hành là dính ngay |

Hệ quả thực tế nếu cố làm "đủ 100%": app phình từ ~15MB lên >1GB (model AI
+ kho effect), thời gian từ vài tuần lên tính bằng năm, và vẫn thiếu đúng
phần không copy được (kho template/nhạc + AI cloud) — tức tốn nhất mà vẫn
không giống hệt. Hướng đúng: **giống hệt về trải nghiệm edit cốt lõi,
thay phần cloud/bản quyền bằng bản local/tự tạo**, theo thứ tự Phase 0→3.
