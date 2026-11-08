---
name: pr-merge
description: Tạo Pull Request trên GitHub cho các thay đổi hiện tại và merge vào main. Dùng khi người dùng nói "tạo PR", "mở PR", "merge vào main", "ship thay đổi này", "đẩy code lên và merge", "create a PR", "merge to main".
---

# Tạo PR và merge vào main

Repo: `quyngdinh/gen-video-ai` (remote `origin`, nhánh chính `main`). Dùng `gh` CLI (đã đăng nhập).

## 1. Tạo nhánh, commit và push (bắt buộc trước khi tạo PR)

PR chỉ tạo được khi nhánh đã có trên GitHub. Làm theo skill **`branch-push`** (`.claude/skills/branch-push/SKILL.md`): kiểm tra trạng thái → tạo nhánh → chạy test → commit → `git push -u origin HEAD`.

Nếu đang ở nhánh tính năng và mọi commit đã được push (`git status` báo "up to date with origin/…") thì bỏ qua bước này.

## 2. Tạo PR

```bash
gh pr create --base main --title "<tiêu đề>" --body "$(cat <<'EOF'
## Tóm tắt
- <thay đổi chính>

## Kiểm thử
- [x] npm test
EOF
)"
```

- Tiêu đề PR giống commit chính. Body gồm: Tóm tắt, Kiểm thử, (Ghi chú nếu có). Kết thúc bằng dòng attribution hệ thống yêu cầu (nếu có).
- Nếu nhánh đã có PR: `gh pr view --web` hoặc `gh pr view` thay vì tạo mới.
- Gửi link PR cho người dùng.

## 3. Merge vào main

**Chỉ merge khi người dùng đã đồng ý rõ ràng** (trong yêu cầu ban đầu hoặc sau khi hỏi). Trước khi merge:

```bash
gh pr checks          # CI phải xanh (nếu repo có CI)
gh pr view --json mergeable,mergeStateStatus
```

- Nếu có conflict: `git fetch origin && git rebase origin/main`, sửa conflict, chạy lại test, `git push --force-with-lease`. Không dùng `--force` trần.
- Merge bằng squash và xoá nhánh:

```bash
gh pr merge --squash --delete-branch
```

## 4. Dọn dẹp local

```bash
git switch main
git pull --ff-only origin main
```

Báo lại cho người dùng: link PR, commit đã merge (`git log -1 --oneline`), và nhánh đã xoá.

## Quy tắc an toàn

- Không push thẳng `main`, không `git push --force` lên `main`.
- Không merge khi test/CI fail, trừ khi người dùng nói rõ chấp nhận.
- Không dùng `--admin` để vượt branch protection nếu người dùng không yêu cầu.
