---
name: branch-push
description: Tạo nhánh mới từ main, commit thay đổi và push nhánh lên GitHub (origin) — bước bắt buộc trước khi tạo PR. Dùng khi người dùng nói "tạo branch", "tạo nhánh", "push lên branch", "đẩy code lên nhánh mới", "create a branch and push", hoặc khi skill pr-merge cần nhánh đã được push.
---

# Tạo nhánh và push lên GitHub

PR trên GitHub so sánh **hai nhánh nằm trên remote**. Vì vậy phải push nhánh lên `origin` trước, rồi mới tạo PR được (`gh pr create` sẽ báo lỗi hoặc hỏi push nếu nhánh chưa có trên remote).

Repo: `quyngdinh/gen-video-ai`, remote `origin`, nhánh chính `main`.

## 1. Kiểm tra trạng thái

```bash
git status --short
git branch --show-current
git fetch origin
```

- Xem `git diff --stat` để biết thay đổi gì. Không commit file bí mật (`.env`, key, token) hay file rác (video output, `node_modules`, file tạm) — nếu thấy thì hỏi người dùng.
- Không có thay đổi nào → báo người dùng và dừng.

## 2. Tạo nhánh

Nếu đang ở `main` (hoặc nhánh không liên quan), tạo nhánh mới. Thay đổi chưa commit sẽ đi theo sang nhánh mới.

Quy tắc đặt tên (chữ thường, gạch ngang, không dấu):

- `feat/<mo-ta>` – tính năng mới
- `fix/<mo-ta>` – sửa lỗi
- `chore/<mo-ta>` – tài liệu, cấu hình, dọn dẹp

```bash
git switch -c feat/<mo-ta>
```

Nếu `main` local đang cũ hơn `origin/main` và chưa có thay đổi nào, tạo nhánh từ bản mới nhất: `git switch -c feat/<mo-ta> origin/main`.

Nếu đã ở đúng nhánh tính năng thì giữ nguyên, không tạo nhánh mới.

## 3. Chạy test

```bash
npm test
npm run test:music   # nếu có đụng tới lib/music.js hoặc public/music.*
```

Test fail → báo người dùng kèm output, không tự ý bỏ qua.

## 4. Commit

- `git add <file cụ thể>` — tránh `git add -A` mù quáng.
- Message theo Conventional Commits, ví dụ `feat: thêm watermark cho video`.
- Kết thúc message bằng dòng attribution hệ thống yêu cầu (nếu có).

```bash
git add <files>
git commit -m "feat: <mô tả>" -m "<chi tiết nếu cần>"
```

## 5. Push lên nhánh trên remote

```bash
git push -u origin HEAD
```

- `-u` gắn nhánh local với `origin/<tên-nhánh>`, lần sau chỉ cần `git push`.
- Không bao giờ push thẳng lên `main`. Không dùng `--force`; nếu đã rebase thì dùng `git push --force-with-lease`.

Kiểm tra đã lên remote:

```bash
git ls-remote --heads origin "$(git branch --show-current)"
```

## 6. Báo lại

Báo người dùng: tên nhánh, commit vừa tạo (`git log -1 --oneline`), và nhánh đã có trên GitHub. Bước tiếp theo là tạo PR → dùng skill `pr-merge`.
