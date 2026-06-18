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
// ADMIN_EMAIL đã được xóa khỏi client — admin check giờ qua Firestore collection 'admins'

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
    // Kiểm tra Firestore admins collection thay vì hardcode email
    let isAdmin = false;
    try {
      const adminDoc = await db.collection('admins').doc(user.email).get();
      isAdmin = adminDoc.exists;
    } catch(e) {
      console.warn('Admin check error:', e);
    }

    if (!isAdmin) {
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
      
      appData.courses.forEach(course => {
        traverseTree(course.tree, [course.order]);
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

function traverseTree(nodes, currentPath) {
  nodes.forEach(node => {
    const path = [...currentPath, node.order];
    if (node.type === 'lesson') {
      if (node.youtubeId) {
        // Tái tạo ID 6 chữ số bằng cách ghép order của Khoá + Chương + Bài học
        // VD: [1, 1, 1] => "010101"
        const prefixId = path.map(p => p.toString().padStart(2, '0')).join('');
        ghPagesMap.set(prefixId, node.title);
      }
    } else if (node.children) {
      traverseTree(node.children, path);
    }
  });
}

// ── UTILS ──
function normalizeId(text) {
  // Tìm chuỗi SỐ ở đầu dòng, bắt buộc theo sau là " ~" (dấu cách và dấu ~) HOẶC chuỗi chỉ chứa số
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
  const ytSet = extractIds(ytInput);
  
  // GH Pages set is keys of ghPagesMap
  const ghSet = new Set(ghPagesMap.keys());
  
  $('count-dl').textContent = dlSet.size;
  $('count-yt').textContent = ytSet.size;
  $('count-gh').textContent = ghSet.size;
  
  // Build report
  allResults = [];
  
  // Combine all known IDs
  let allKnownIds = new Set([...dlSet, ...ytSet, ...ghSet]);
  
  for (let id of allKnownIds) {
    let inDl = dlSet.has(id);
    let inYt = ytSet.has(id);
    let inGh = ghSet.has(id);
    
    let title = ghPagesMap.get(id) || "—";
    let statusClass = "info";
    let statusText = "OK";
    let details = "";
    let filterCat = "ok";
    // safeToDelete: video đã có trên YouTube → có thể xóa file local để tiết kiệm dung lượng
    let safeToDelete = inDl && inYt;
    
    if (inDl && inYt && inGh) {
      statusClass = "success";
      statusText = "HOÀN THẢO";
      details = "Có mặt đầy đủ trên cả 3 nguồn. ✅ An toàn để xóa file local.";
      filterCat = "ok";
    } else {
      let missingFrom = [];
      if (!inDl) missingFrom.push("Download");
      if (!inYt) missingFrom.push("YouTube");
      if (!inGh) missingFrom.push("GH Pages");
      
      if (!inGh && inYt) {
        statusClass = "error";
        statusText = "THIẾU TRÊN WEB";
        details = "Đã upload YouTube nhưng chưa gắn link lên web. ✅ An toàn để xóa file local.";
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
    
    allResults.push({ id, title, statusClass, statusText, details, filterCat, safeToDelete });
  }
  
  // Sort: errors first, then warnings, then successes
  allResults.sort((a, b) => {
    const order = { "error": 1, "warning": 2, "info": 3, "success": 4 };
    return order[a.statusClass] - order[b.statusClass];
  });

  // Cập nhật badge số lượng có thể xóa
  const deleteCount = allResults.filter(r => r.safeToDelete).length;
  $('btn-safe-delete').textContent = `🗑️ Có thể xóa Local (${deleteCount})`;
  
  $('report-section').style.display = 'block';
  renderTable("all");
}

// ── RENDERING ──
function renderTable(filter) {
  const tbody = $('result-body');
  tbody.innerHTML = '';
  
  // Hiện/ẩn nút copy lệnh xóa
  $('delete-cmd-bar').style.display = (filter === 'safe-to-delete') ? 'block' : 'none';

  let toShow = allResults;
  if (filter === 'safe-to-delete') {
    toShow = allResults.filter(r => r.safeToDelete);
  } else if (filter !== "all") {
    toShow = allResults.filter(r => r.filterCat === filter);
  }
  
  if (toShow.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.style.cssText = 'text-align: center; color: var(--text-muted);';
    td.textContent = 'Không có dữ liệu phù hợp';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  
  toShow.forEach(r => {
    // Dùng DOM API thay innerHTML để tránh XSS từ dữ liệu Firestore
    const tr = document.createElement('tr');
    const tdId = document.createElement('td');
    const strong = document.createElement('strong');
    strong.textContent = r.id;
    tdId.appendChild(strong);

    const tdTitle = document.createElement('td');
    tdTitle.textContent = r.title;

    const tdStatus = document.createElement('td');
    const span = document.createElement('span');
    span.className = 'status ' + r.statusClass;
    span.textContent = r.statusText;
    tdStatus.appendChild(span);

    const tdDetails = document.createElement('td');
    tdDetails.textContent = r.details;

    tr.appendChild(tdId);
    tr.appendChild(tdTitle);
    tr.appendChild(tdStatus);
    tr.appendChild(tdDetails);
    tbody.appendChild(tr);
  });
}

// ── COPY DELETE COMMAND ──
function copyDeleteCmd() {
  const safeIds = allResults.filter(r => r.safeToDelete).map(r => r.id);
  if (safeIds.length === 0) {
    alert("Không có video nào có thể xóa!");
    return;
  }

  // Tạo lệnh PowerShell: tìm file bắt đầu bằng ID trong toàn bộ thư mục VIDDOWNLOAD
  const lines = safeIds.map(id =>
    `Get-ChildItem "D:\\VIDDOWNLOAD" -Recurse -Filter "${id} ~*.mp4" | Remove-Item -Force`
  );
  const cmd = lines.join('\n') + '\nWrite-Host "Done! Da xoa ' + safeIds.length + ' video da upload len YouTube."';

  navigator.clipboard.writeText(cmd).then(() => {
    alert(`Đã copy lệnh xóa ${safeIds.length} video vào Clipboard!\nMở PowerShell, dán (Ctrl+V) và nhấn Enter để xóa.`);
  }).catch(() => {
    // Fallback: hiển thị trong textarea tạm
    const ta = document.createElement('textarea');
    ta.value = cmd;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    alert(`Đã copy lệnh xóa ${safeIds.length} video!\nMở PowerShell, dán và nhấn Enter.`);
  });
}

// ── FILTER EVENTS ──
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    renderTable(e.target.dataset.filter);
  });
});

// ── BUTTON BINDINGS (thay onclick= inline đã xóa để tuân thủ CSP no-unsafe-inline) ──
(function bindEvents() {
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
  on('btn-back-home', () => { window.location.href = 'index.html'; });
  on('btn-settings',  () => { window.location.href = 'index.html'; });
  on('btn-goto-home', () => { window.location.href = 'index.html'; });
  on('btn-signout',   () => signOut());
  on('btn-run-check', () => runCheck());
  on('btn-copy-delete', () => copyDeleteCmd());
})();
