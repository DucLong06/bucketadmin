// Name rules checked while typing. The backend (src-tauri/src/s3/manage.rs) enforces the same ones.

/** Why `name` is not a valid S3 bucket name, or null when it is. */
export function bucketNameError(name: string): string | null {
  if (name.length < 3 || name.length > 63) return "Tên bucket dài từ 3 đến 63 ký tự.";
  if (!/^[a-z0-9.-]+$/.test(name)) return "Chỉ dùng chữ thường, số, dấu chấm và dấu gạch ngang.";
  if (!/^[a-z0-9]/.test(name) || !/[a-z0-9]$/.test(name)) return "Phải bắt đầu và kết thúc bằng chữ hoặc số.";
  if (/\.\.|\.-|-\./.test(name)) return "Dấu chấm phải nằm giữa chữ hoặc số.";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return "Tên bucket không được có dạng địa chỉ IP.";
  return null;
}

/** Why `name` cannot be a folder name (one path segment), or null when it can. */
export function folderNameError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Nhập tên thư mục.";
  if (trimmed.includes("/")) return "Tên thư mục không chứa dấu /.";
  if (trimmed === "." || trimmed === "..") return "Tên này không dùng được.";
  if (trimmed.length > 255) return "Tên thư mục quá dài.";
  return null;
}
