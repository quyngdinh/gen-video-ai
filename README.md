# GenVideo AI

Web app chạy trên **localhost**: dán kịch bản + tải ảnh asset → tạo **voice-over + SRT** bằng API genmax.io → dựng **video 16:9 hoặc 9:16** (720p / 1080p…) có hiệu ứng phủ (lửa, mưa, tuyết…), phụ đề và nhạc nền. Giao diện lấy cảm hứng từ Vsub.

Không cần `npm install` (không dùng thư viện ngoài), chỉ cần **Node.js ≥ 20.3** và **FFmpeg**.

## Chạy

```bash
brew install ffmpeg      # một lần duy nhất (cần bản có libass để đốt phụ đề)
cd ~/Desktop/Project/gen-video-ai
npm start                # hoặc bấm đúp file start.command
```

Mở http://localhost:3000

## Dùng

1. **Cài đặt** → dán API key genmax.io → *Lưu & kiểm tra key*. (Có thể đặt giọng mặc định ở đây.)
2. **Tạo video**
   1. Chọn khổ **Long form 16:9** hay **Short form 9:16**, độ phân giải (**1080p khuyên dùng**), FPS.
   2. Tải / kéo thả / dán ảnh asset. Kéo để đổi thứ tự. Bấm vào một ảnh để chọn **hiệu ứng phủ** (lửa bập bùng, mưa, tuyết, sương, hạt lơ lửng, chớp sáng, phim cũ) và bấm lên ảnh để đặt vị trí đống lửa. Muốn AI gợi ý thì bấm **🪄 Gợi ý hiệu ứng bằng AI** — tải ảnh lên không tự gọi AI. Nút **🗑 Xoá tất cả ảnh** bỏ toàn bộ ảnh một lần.
   3. Chọn cách đặt ảnh (trọn ảnh + nền mờ / phủ kín / nền màu), kiểu chuyển cảnh, độ dài mỗi cảnh.
   4. Bật/tắt phụ đề, chọn kiểu, vị trí, cỡ chữ.
   5. Chọn nhà cung cấp và model (danh sách tải từ genmax), chọn giọng bằng nút *Chọn giọng…* (thư viện ElevenLabs / MiniMax / CapCut, giọng mặc định, giọng đã clone, yêu thích; lọc theo ngôn ngữ, giọng vùng, giới tính, độ tuổi…) hoặc dán voice ID, rồi dán kịch bản.
   6. (Tuỳ chọn) nhạc nền.
3. Bấm **🎙 Tạo voice + SRT** để chỉ lấy `mp3` + `srt`, hoặc **🎬 Tạo video** để làm hết một lần.
   - Nếu kịch bản và giọng không đổi, lần dựng lại **không tốn thêm credit giọng**.
4. Tải MP4 / MP3 / SRT ở phần *Kết quả* hoặc trang *Dự án*.

## Video nhạc thiếu nhi (mục riêng)

Menu **Video nhạc** dựng video ca nhạc từ **bài hát có sẵn** (đã có giọng hát) và **các clip video ngắn**, thay cho giọng TTS + ảnh. Mục này tách riêng hẳn: dữ liệu ở `data/music/`, API `/api/music/…`, không ảnh hưởng mục *Tạo video* và *Dự án*. Không tốn credit genmax.

**Video intro (bắt buộc):** tải một video intro ở mục đầu trang. Intro dùng chung cho mọi video nhạc (lưu ở `data/music/intro/`) và được nối vào đầu video khi dựng, tự đưa về đúng khổ, độ phân giải, FPS và cách đặt clip của video. Chưa có intro thì không dựng được. Lời karaoke, tên bài và file SRT tải về đều bắt đầu sau intro (file LRC vẫn tính theo bài hát).

**Video outro (bắt buộc):** tải một video outro ở mục 2. Giống intro: dùng chung cho mọi video nhạc (lưu ở `data/music/outro/`), tự đưa về đúng khổ, độ phân giải, FPS và được nối vào **cuối** video khi dựng. Chưa có outro thì không dựng được.

**Logo kênh (bắt buộc):** tải ảnh logo ở mục 3. Chưa có logo thì không dựng được. Logo dùng chung cho mọi video nhạc (lưu ở `data/music/logo/`) và hiện ở góc video **trong phần bài hát** (không có trong intro / outro). Ảnh JPG nền trắng hoặc nền trơn được tự xoá nền: app loang từ mép ảnh vào, xoá nền và bóng đổ xám, giữ phần trắng nằm trong logo (ví dụ viền trắng quanh chữ có nét viền bao ngoài), rồi cắt sát logo. PNG đã có nền trong suốt thì giữ nguyên. Logo cố định ở góc trên phải, rộng 10% bề ngang video; chỉnh được độ đậm. Tắt *Tự xoá nền ảnh* nếu muốn giữ cả khung ảnh. Lỗ kín trong chữ (như lòng chữ B, O) không nối với mép ảnh nên vẫn giữ màu nền gốc.

1. Chọn khổ 16:9 / 9:16, độ phân giải.
2. Tải file nhạc (mp3 · m4a · wav…). Không cần dán lời: app tự làm 3 việc:
   - **dò nhịp (BPM)** để cắt cảnh đúng phách;
   - **AI nghe bài hát**: Gemini chép lời từng câu, rồi nghe lại lần 2 để chấm thời gian chính xác hơn;
   - tự đoán tên bài.

   Bước AI cần key Gemini và model Gemini trong *Cài đặt*, vì Claude không nghe được âm thanh. Bài 40 giây mất khoảng 25 giây.
   - **🧭 Mốc các đoạn bài hát**: dán lời có nhãn đoạn (`[Intro]`, `[Verse 1]`, `[Chorus 1]`, `[Bridge]`, `[Final Chorus]`, `[Outro]`…; `Chorus:`, `(Verse 2)`, `ĐK:` cũng nhận) rồi bấm **Tìm mốc các đoạn**. Gemini nghe bài hát và trả thời điểm bắt đầu + độ dài từng đoạn. Nhãn lặp không đánh số tự thành *Chorus 1, Chorus 2…*. Không có nhãn thì AI tự chia theo cấu trúc chuẩn (Intro, Verse 1, Chorus 1, Verse 2, Chorus 2, Bridge, Verse 3, Final Chorus, Outro). Đoạn AI không chắc mà câu đầu đã có trong bảng câu hát thì lấy giờ của câu đó. Bấm ▶ để nghe đúng đoạn đó (hết đoạn tự dừng, bấm ⏹ để dừng sớm), sửa tay ô thời gian. Ô **📄 Mốc các đoạn** in sẵn mốc để chép, chọn dạng *YouTube* (`0:00 Intro`, dán vào mô tả thành chương), *Bắt đầu – kết thúc* hoặc *Kèm câu đầu*; bấm **📋 Chép mốc** hoặc bấm vào ô rồi Cmd+C.
3. Tải **clip video** (mp4 · mov · webm · m4v, tối đa 600MB / clip). Ảnh tĩnh cũng dùng được.
   - Rê chuột lên clip để xem. Kéo thả để đổi thứ tự.
   - Công tắc **🔇 Tắt âm thanh tất cả clip** (mặc định bật). Tắt đi thì tiếng clip được trộn dưới bài hát, có thanh chỉnh âm lượng.
   - Nút ⭐ 🫧 🎵 💖 🎉 🎈 dưới clip bật hiệu ứng thiếu nhi cho các cảnh dùng clip đó.
4. **Lời & clip theo nhạc** (bảng câu hát):
   - Kiểm tra chữ AI chép, sửa trực tiếp trong bảng. Thêm câu AI bỏ sót bằng **＋ Thêm câu**, xoá câu bằng ×. Bấm ▶ để nghe từng câu (hết câu tự dừng, bấm ⏹ để dừng).
   - **⏱ AI chấm lại thời gian**: giữ chữ đã sửa, AI chỉ chấm lại thời gian.
   - **🤖 AI nghe lại lời**: chép lại toàn bộ lời từ đầu.
   - **🎯 Chấm tay**: bấm **Space** đúng lúc giọng hát bắt đầu mỗi câu. **K** đánh dấu hết câu, **←** chấm lại câu trước, **Esc** dừng.
   - **−0.1s / +0.1s**: dời cả bài khi lời hiện sớm hoặc muộn đều so với giọng hát.
   - Thử với bài 40 giây: AI chép đúng 7/7 câu, thời gian lệch trung bình khoảng 0,2–0,3 giây.
   - **🤖 AI tự xếp clip theo nhạc**: AI xem 3 khung hình (đầu / giữa / cuối) của từng clip, ghi mô tả, từ khoá và mức sôi động 1–5. Sau đó AI chọn cho mỗi câu một clip, theo các tiêu chí:
     - khớp lời;
     - điệp khúc dùng lại đúng clip của lần đầu;
     - đoạn sôi động dùng clip sôi động;
     - có thêm một clip riêng cho đoạn nhạc dạo.

     Mô tả clip được nhớ lại, lần sau không tốn tiền.
   - **🎞 Tự xếp** (không AI): chia đều clip, điệp khúc dùng lại clip. Có thể sửa tay clip của từng câu / clip nhạc dạo.
5. Hình & chữ:
   - Cách đặt clip vào khung.
   - **Cắt đúng nhịp**.
   - **Mỗi cảnh dài tối đa**: đoạn nhạc dạo dài hơn thì đổi clip, điểm chuyển rơi đúng phách.
   - Lời **karaoke** với 10 bộ màu và 10 font sinh động có đủ dấu tiếng Việt (chọn font thì màu chữ tự đổi theo font, vẫn chỉnh lại được), tên bài hiện lúc nhạc dạo.
6. **🎬 Dựng video nhạc** → tải MP4, kèm `lyrics.srt` / `lyrics.lrc`.

Video nhạc cũng hiện ở trang **Dự án** (nhãn 🎵 Video nhạc), có các nút Mở, tải MP4 / SRT, Finder và Xoá.

Cách cắt cảnh:
- Clip đổi ở đầu mỗi câu hát, được kéo về phách gần nhất.
- Mỗi câu chỉ dùng một clip; clip ngắn hơn câu thì chạy lại từ đầu.
- Một clip dùng lại nhiều lần sẽ chạy tiếp đoạn sau của nó. Nếu clip hết giữa chừng thì giữ khung hình cuối.

Hiệu ứng và chữ karaoke vẽ bằng phụ đề ASS ở bước ghép cuối, nên hầu như không làm chậm việc dựng.

Thử không tốn tiền: `npm run test:music` (dùng AI giả lập).

## Cách app ghép video

- Kịch bản được tách theo câu, gửi genmax từng đoạn ≤ 4500 ký tự, rồi nối lại.
- SRT lấy từ genmax (`export_transcript`); nếu thiếu hoặc không khớp, app tự chia theo độ dài câu.
- **Prompt ảnh cho từng cảnh** (mục 2 → *📝 Tạo prompt ảnh cho từng cảnh*): nhập phong cách ảnh (bắt buộc 1, thêm tối đa 3 phong cách khi kịch bản có nhiều phần khác nhau — mỗi phong cách có thể ghi kèm “dùng cho cảnh nào”), AI chia kịch bản thành các cảnh ~15 giây, viết rõ từng phong cách + mô tả nhân vật chung, chọn phong cách hợp nhất cho từng cảnh rồi viết prompt tiếng Anh (đã ghép đúng phong cách của cảnh đó) (cho Gemini / ChatGPT / Midjourney), kèm tên file gợi ý `scene-NN_…`. Chép từng prompt hoặc tải .txt / .csv / .md (.md chỉ gồm nội dung prompt, mỗi prompt cách một dòng trống); dừng giữa chừng thì bấm lại để viết tiếp. Tạo ảnh xong, đặt tên theo gợi ý, tải lên rồi bấm *📋 Tự xếp* — ảnh tự vào đúng cảnh.
- **Xếp ảnh theo kịch bản** (mục 3 → *🎬 Tự động xếp ảnh theo kịch bản bằng AI*): kịch bản được chia thành các đoạn ~15 giây; AI xem từng ảnh (mô tả ngắn) rồi chọn ảnh hợp nhất cho từng đoạn, ảnh không khớp được đánh dấu *không dùng*. Duyệt / đổi ảnh từng đoạn trong bảng *Kịch bản ↔ ảnh*; không có AI thì bấm *📋 Tự xếp* để gán tay. Khi dựng, ảnh đổi đúng lúc giọng đọc tới đoạn đó (theo mốc SRT).
- Không có bảng xếp: ảnh được chia đều theo thời lượng, **đổi ảnh đúng chỗ ngắt câu**. Ảnh đứng yên (không zoom / lia, không rung máy — dễ nhức mắt nên đã bỏ).
- FFmpeg dựng từng cảnh → ghép → đốt phụ đề (ASS) + trộn giọng, nhạc nền, chuẩn hoá âm lượng.
- Hiệu ứng phủ chạy bằng FFmpeg; ánh lửa và tàn lửa đặt đúng vị trí đống lửa trong ảnh. Cảnh có hiệu ứng render chậm hơn (khoảng 1–2 lần thời lượng cảnh trên M1).

## AI gợi ý hiệu ứng (tuỳ chọn)

Cài đặt → **AI gợi ý hiệu ứng**: chọn Claude (Anthropic), Gemini (Google), dán API key, bấm *Lưu & kiểm tra key* rồi chọn model trong dropdown (lấy trực tiếp từ API, chỉ model nhìn được ảnh).
- Ảnh được thu nhỏ còn ≤1280px trước khi gửi; kết quả nhớ trong `data/ai-cache.json` theo nội dung ảnh + model, nên cùng một ảnh không tính tiền hai lần.
- Key lưu trong `.env` như key genmax, không gửi về trình duyệt; app chỉ gửi ảnh thu nhỏ, không gửi kịch bản.
- Với Claude Opus 5.5 / Sonnet 5.5 / Opus 5 / Fable 5.1, app bật `fallbacks: "default"`: nếu bộ lọc an toàn từ chối, API tự chạy lại bằng model phù hợp.

## Thử không tốn credit

```bash
npm run mock        # giả lập genmax tại http://127.0.0.1:4010
npm test            # test đầu-cuối (tự chạy mock genmax + mock Claude/Gemini + server)
```
Trong Cài đặt đặt Base URL = `http://127.0.0.1:4010` và API key bất kỳ.

## Cấu trúc

```
server.js          máy chủ HTTP + API (không dùng thư viện ngoài)
lib/config.js      Settings (data/settings.json; API key ở .env, chmod 600) + giọng yêu thích
lib/genmax.js      client API genmax.io (tạo TTS, chờ task, tải audio/SRT, model, ngôn ngữ, thư viện giọng)
lib/srt.js         tách câu, SRT, ASS
lib/ffmpeg.js      chạy FFmpeg, đặt ảnh vào khung, chia cảnh
lib/effects.js     hiệu ứng phủ (mưa, tuyết, lửa, sương…) bằng filter FFmpeg
lib/vision.js      AI nhìn ảnh (Claude / Gemini) gợi ý hiệu ứng + vị trí lửa
lib/pipeline.js    dự án, hàng đợi, bước giọng, bước dựng
lib/music.js       video nhạc: lời LRC/SRT, AI xem + xếp clip, cắt cảnh theo câu hát + nhịp, karaoke + hiệu ứng (ASS), dựng
lib/beats.js       dò nhịp bài hát (BPM + vị trí phách)
public/            giao diện (HTML/CSS/JS thuần); music.js + music.css là trang Video nhạc
test/              mock genmax, mock Claude/Gemini + test đầu-cuối
data/              dữ liệu dự án (tự tạo, không commit)
```

## Bảo mật

- Server chỉ lắng nghe `127.0.0.1`, từ chối Host/Origin lạ (chống trang web khác gọi vào app).
- API key chỉ nằm trong file `.env` (đã gitignore, xem `.env.example`), không gửi về trình duyệt, chỉ gửi tới host genmax đã cấu hình.
- Chỉ phục vụ đúng các file của dự án (ảnh, voice, srt, mp4), không đọc được file khác.

## Chưa làm (gợi ý bước sau)

- Phụ đề từng từ (karaoke) bằng Whisper chạy local.
- Tự sinh ảnh cho các cảnh thiếu bằng Gemini API (cần API key riêng, có tính phí).
- Dùng `h264_videotoolbox` để render nhanh hơn trên chip M1.
