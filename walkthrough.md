# Hoàn thành Color Settings Popup

Tôi đã triển khai thành công hệ thống **Color Settings Popup** (Phase 3) theo đúng Kế hoạch v2 mà chúng ta đã thống nhất. Tính năng này cho phép bạn thay đổi toàn bộ tông màu của web một cách nhất quán (Photoshop-style) đồng thời điều khiển các hiệu ứng nâng cao.

## 1. Hue Shift (Thay đổi màu chủ đạo)

Hệ thống màu giờ đây rất thông minh và linh hoạt:

- **System Colors xoay đồng bộ**: Tất cả các màu nền (`--color-bg`), màu bề mặt (`--color-surface`), viền (`--color-border`), và chữ (`--color-text`) đều tự động xoay Hue theo cùng một khoảng cách (ΔHue) so với Hue bạn chọn. Điều này giúp bảo toàn được tỉ lệ tương phản và độ "hòa quyện" của giao diện (ví dụ màu nền tối vẫn sẽ hơi ám màu chủ đạo).
- **Shadow Interpolation**: Đổ bóng (shadow) của các phần tử kính mờ và nút bấm sẽ phát sáng theo đúng màu chủ đạo mới nhờ vào thuật toán nội suy chuỗi `replace('{h}', finalHue)`.
- **Semantic Colors giữ nguyên**: Các màu mang ý nghĩa trạng thái như xanh lá (thành công), đỏ (lỗi), vàng (cảnh báo) hoàn toàn KHÔNG bị thay đổi, giữ vững trải nghiệm UX của người học.

## 2. Các Controls Nâng cao

Trên popup, tab **Cơ bản (Simple)** cung cấp các tính năng:
- **Thanh trượt Hue**: Đổi màu chủ đạo mượt mà từ 0° đến 360°.
- **Toggle Nền động**: Bật/tắt hiệu ứng Blob Animation (canvas WebGL) trong background để tối ưu hiệu năng.
- **Tốc độ nền**: Thanh trượt tăng giảm tốc độ chuyển động của các khối màu ở nền.
- **Toggle Hiệu ứng kính mờ (Glassmorphism)**: Nếu người dùng cảm thấy web bị giật hoặc khó nhìn, họ có thể tắt Glassmorphism. Thuộc tính `backdrop-filter` sẽ bị xóa, và giao diện sẽ dùng màu bề mặt đục (`--color-surface2`) thay thế.

Tab **Nâng cao (Advanced)** hiện tại liệt kê ra toàn bộ CSS tokens (hơn 20 biến) để bạn có cái nhìn tổng quan. 

## 3. Lưu trữ cấu hình (Persist)

Bất kỳ thay đổi nào (màu sắc, tốc độ nền, bật/tắt kính mờ) đều được lưu ngay lập tức vào `localStorage` của trình duyệt. 

Hàm `loadSavedSettings()` được gắn vào sự kiện khởi tạo trang (`DOMContentLoaded`), do đó khi người dùng tải lại trang hoặc sang trang Admin, giao diện cá nhân hóa của họ vẫn sẽ được giữ nguyên vẹn.

> [!TIP]
> **Cách mở Popup**
> Bạn có thể mở Color Settings bằng cách bấm vào **biểu tượng Bảng màu (🎨)** ở góc trên bên phải thanh Header (cạnh chỗ thông tin User / nút ⚙).
> Hoặc mở thủ công bằng console: `window.openColorSettings()`.

> [!NOTE]
> Giao diện Light Mode hiện tại đã được gác lại theo định hướng của bạn để tập trung vào việc hoàn thiện Dark Mode Hue Shift trước. Nếu cần, chúng ta có thể làm bộ Light Mode riêng biệt sau này.
