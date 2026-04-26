// ── CONFIG ──
const firebaseConfig = {
  apiKey: "AIzaSyCRLENh_UEBdXzukzpXVHHTltSapqyNWVc",
  authDomain: "brightwebaccbase.firebaseapp.com",
  projectId: "brightwebaccbase",
  storageBucket: "brightwebaccbase.firebasestorage.app",
  messagingSenderId: "482143691238",
  appId: "1:482143691238:web:67dd3871bc93bf08c03627",
  measurementId: "G-LXMQJM43PN"
};
const ADMIN_EMAIL = "mcdg5444@gmail.com";

// ── PARTICLES CONFIG ──
const PARTICLES_CONFIG = {
  "particles": {
    "number": { "value": 50, "density": { "enable": true, "value_area": 300 } },
    "color": { "value": "#37b1f8" },
    "shape": { "type": "circle", "stroke": { "width": 4, "color": "#1d4470" } },
    "opacity": { "value": 1, "random": true, "anim": { "enable": true, "speed": 1, "opacity_min": 0.7, "sync": false } },
    "size": { "value": 5, "random": true, "anim": { "enable": true, "speed": 5, "size_min": 4, "sync": true } },
    "line_linked": { "enable": true, "distance": 130, "color": "#ffffff", "opacity": 0.3, "width": 1 },
    "move": { "enable": true, "speed": 4, "direction": "none", "random": true, "straight": false, "out_mode": "out", "bounce": false }
  },
  "interactivity": {
    "detect_on": "canvas",
    "events": { "onhover": { "enable": true, "mode": "bubble" }, "onclick": { "enable": true, "mode": "push" }, "resize": true },
    "modes": {
      "bubble": { "distance": 100, "size": 10, "duration": 0.97, "opacity": 0.99, "speed": 3 },
      "push": { "particles_nb": 4 }, "remove": { "particles_nb": 2 }
    }
  },
  "retina_detect": true
};

// ── INIT ──
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

const $ = id => document.getElementById(id);
let appData = null;
let ghPagesMap = new Map(); // id -> title
let ytSet = new Set(); // ID already uploaded to YouTube
let allResults = []; // Store results for filtering

// Particles Init
particlesJS('particles-js', PARTICLES_CONFIG);

function showLoad() { $('loading').classList.add('show'); }
function hideLoad() { $('loading').classList.remove('show'); }

function signOut() { 
  auth.signOut().then(() => window.location.href = 'index.html'); 
}

// ── AUTH CHECK ──
auth.onAuthStateChanged(async user => {
  if (user) {
    if (user.email !== ADMIN_EMAIL) {
      // Not admin
      $('unauthorized-msg').style.display = 'block';
      $('page-admin').style.display = 'none';
      $('header').style.display = 'none';
    } else {
      // Is admin
      $('user-info').textContent = user.displayName || user.email;
      $('header').style.display = 'flex';
      $('unauthorized-msg').style.display = 'none';
      $('page-admin').style.display = 'block';
      
      showLoad();
      await loadGhPagesData();
      hideLoad();
    }
  } else {
    // Not logged in
    window.location.href = 'index.html';
  }
});

// ── LOAD GH PAGES DATA ──
async function loadGhPagesData() {
  try {
    const doc = await db.collection('app_data').doc('courses').get();
    if (doc.exists) {
      appData = JSON.parse(doc.data().json);
      ghPagesMap.clear();
      
      // Load YouTube uploaded IDs directly from Firestore
      ytSet = new Set(appData.youtubeIds || []);
      
      appData.courses.forEach(course => {
        traverseTree(course.tree);
      });
      console.log(`Loaded ${ghPagesMap.size} videos from GitHub Pages data.`);
    } else {
      alert("Không tìm thấy dữ liệu khóa học trên Firestore.");
    }
  } catch(e) {
    console.error(e);
    alert("Lỗi tải dữ liệu: " + e.message);
  }
}

function traverseTree(nodes) {
  nodes.forEach(node => {
    if (node.type === 'lesson') {
      if (node.youtubeId && node.prefix) {
        // Sử dụng luôn mã prefix 6 số đã được sync_drive.py tạo ra sẵn
        ghPagesMap.set(node.prefix, node.title);
      }
    } else if (node.children) {
      traverseTree(node.children);
    }
  });
}

// ── UTILS ──
function normalizeId(text) {
  // Tìm chuỗi SỐ ở đầu dòng, bắt buộc theo sau là " ~" (dấu cách và dấu ~) HOẶC chuỗi chỉ chứa số (dữ liệu script xuất ra)
  const match = text.trim().match(/^(\d+)(?: ~|$)/);
  if (match) {
    return match[1]; 
  }
  return null;
}

function extractIds(inputStr) {
  if (!inputStr.trim()) return new Set();
  
  let ids = [];
  try {
    let parsed = JSON.parse(inputStr);
    if (Array.isArray(parsed)) {
      parsed.forEach(item => {
        let id = normalizeId(String(item));
        if (id) ids.push(id);
      });
      return new Set(ids);
    }
  } catch (e) { /* ignore JSON parse error */ }

  let lines = inputStr.split('\n');
  for (let line of lines) {
    let clean = line.trim();
    if (!clean) continue;
    let id = normalizeId(clean);
    if (id) ids.push(id);
  }
  return new Set(ids);
}

// ── CHECKING LOGIC ──
function runCheck() {
  const dlInput = $('input-downloaded').value;
  const ytInput = $('input-uploaded').value;
  
  const dlSet = extractIds(dlInput);
  const manualYtSet = extractIds(ytInput);
  
  // Kết hợp danh sách YouTube: Tự động (từ Firestore) + Thủ công (từ ô nhập)
  const combinedYtSet = new Set([...ytSet, ...manualYtSet]);
  
  // GH Pages set is keys of ghPagesMap
  const ghSet = new Set(ghPagesMap.keys());
  
  $('count-dl').textContent = dlSet.size;
  $('count-yt').textContent = combinedYtSet.size;
  $('count-gh').textContent = ghSet.size;
  
  // Build report
  allResults = [];
  
  // Combine all known IDs
  let allKnownIds = new Set([...dlSet, ...combinedYtSet, ...ghSet]);
  
  for (let id of allKnownIds) {
    let inDl = dlSet.has(id);
    let inYt = combinedYtSet.has(id);
    let inGh = ghSet.has(id);
    
    let title = ghPagesMap.get(id) || "—";
    let statusClass = "info";
    let statusText = "OK";
    let details = "";
    let filterCat = "all";
    
    if (inDl && inYt) {
      if (inGh) {
        statusClass = "success";
        statusText = "HOÀN HẢO";
        details = "Có mặt đầy đủ trên cả 3 nguồn. An toàn để xóa trên máy.";
        filterCat = "ok";
      } else {
        statusClass = "error";
        statusText = "THIẾU TRÊN WEB";
        details = "Đã upload YouTube nhưng chưa gắn link lên web. An toàn để xóa trên máy.";
        filterCat = "missing-gh";
      }
      // Bất cứ video nào inDl && inYt đều an toàn để xóa
      allResults.push({ id, title, statusClass, statusText, details, filterCat, safeToDelete: true });
      continue;
    } else {
      let missingFrom = [];
      if (!inDl) missingFrom.push("Download");
      if (!inYt) missingFrom.push("YouTube");
      if (!inGh) missingFrom.push("GH Pages");
      
      if (!inGh && inYt) {
        statusClass = "error";
        statusText = "THIẾU TRÊN WEB";
        details = "Đã upload YouTube nhưng chưa gắn link lên web.";
        filterCat = "missing-gh";
      } else if (!inYt && inDl) {
        statusClass = "warning";
        statusText = "CHƯA UPLOAD";
        details = "Đã download nhưng chưa up lên YouTube.";
        filterCat = "missing-yt";
      } else if (inGh && !inDl && !inYt) {
        statusClass = "warning";
        statusText = "ID BẤT THƯỜNG";
        details = "Web có hiển thị nhưng không thấy trong danh sách nguồn.";
        filterCat = "ghost-gh";
      } else {
        statusClass = "error";
        statusText = "LỖI PARITY";
        details = `Thiếu ở: ${missingFrom.join(', ')}`;
        filterCat = "other";
      }
    }
    
    allResults.push({ id, title, statusClass, statusText, details, filterCat, safeToDelete: false });
  }
  
  // Sort: errors first, then warnings, then successes
  allResults.sort((a, b) => {
    const order = { "error": 1, "warning": 2, "info": 3, "success": 4 };
    return order[a.statusClass] - order[b.statusClass];
  });
  
  $('report-section').style.display = 'block';
  renderTable("all");
}

// Events for filters
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    
    const filter = e.target.dataset.filter;
    $('delete-cmd-container').style.display = (filter === 'safe-to-delete') ? 'block' : 'none';
    
    renderTable(filter);
  });
});

function renderTable(filter) {
  const tbody = $('result-body');
  tbody.innerHTML = '';
  
  let toShow = allResults;
  if (filter === "safe-to-delete") {
    toShow = allResults.filter(r => r.safeToDelete);
  } else if (filter !== "all") {
    toShow = allResults.filter(r => r.filterCat === filter);
  }
  
  if (toShow.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">Không có dữ liệu phù hợp</td></tr>`;
    return;
  }
  
  toShow.forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${r.id}</strong></td>
      <td>${r.title}</td>
      <td><span class="status ${r.statusClass}">${r.statusText}</span></td>
      <td>${r.details}</td>
    `;
    tbody.appendChild(tr);
  });
}

function copyDeleteCmd() {
  const safeIds = allResults.filter(r => r.safeToDelete).map(r => `"${r.id}"`);
  if (safeIds.length === 0) {
    alert("Không có video nào cần xóa!");
    return;
  }
  
  // Tạo lệnh PowerShell
  const idsStr = safeIds.join(",");
  const cmd = `$ids = @(${idsStr})\nforeach ($id in $ids) { Get-ChildItem "D:\\VIDDOWNLOAD\\*\\*\\$id*.mp4" -ErrorAction SilentlyContinue | Remove-Item -Force }\nWrite-Host "Da xoa thanh cong cac video da upload tren YouTube!"`;
  
  navigator.clipboard.writeText(cmd).then(() => {
    alert("Đã copy lệnh PowerShell vào Clipboard! Hãy mở PowerShell, dán lệnh này vào và nhấn Enter để xóa.");
  }).catch(err => {
    alert("Không thể copy: " + err);
  });
}
