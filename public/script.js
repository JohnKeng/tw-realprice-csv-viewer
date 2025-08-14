
let CURRENT = { page: 1, total: 0 };

// ---------- helpers ----------
async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) {
    if (typeof c === "string") e.appendChild(document.createTextNode(c));
    else if (c) e.appendChild(c);
  }
  return e;
}
function show(id, on) {
  document.getElementById(id).classList.toggle("hidden", !on);
}

// ---------- upload (with progress) ----------
function uploadZipWithProgress(file, opts = {}) {
  const status = document.getElementById(opts.statusId || "uploadStatus");
  const bar = document.getElementById(opts.progressId || "upProgress");
  status.textContent = "";
  bar.classList.remove("hidden");
  bar.value = 0;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/upload");
    xhr.setRequestHeader("X-Filename", file.name || "upload.zip");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        bar.value = Math.round((e.loaded / e.total) * 100);
      }
    };
    xhr.onload = () => {
      bar.classList.add("hidden");
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          reject(new Error("回應格式錯誤"));
        }
      } else {
        reject(new Error("上傳失敗：" + xhr.status));
      }
    };
    xhr.onerror = () => {
      bar.classList.add("hidden");
      reject(new Error("網路錯誤"));
    };
    xhr.send(file); // raw binary
  });
}

// ---------- manifest & districts ----------
async function loadManifest() {
  const data = await fetchJSON("/api/manifest");
  document.getElementById("period").textContent =
    data.periodFriendly || data.period || "";

  // 有資料就把上傳 UI 收起
  if (data && data.files && Object.keys(data.files).length) {
    show("uploadCard", false);
    show("browser", true);
  }

  const citySel = document.getElementById("city");
  citySel.innerHTML = "";
  const entries = Object.values(data.cities || []);
  entries.sort((a, b) => a.code.localeCompare(b.code));
  for (const c of entries)
    citySel.appendChild(
      el("option", { value: c.code }, c.name || c.code),
    );
  await loadDistricts();
}

async function loadDistricts() {
  const res = await fetchJSON(
    `/api/districts?city=${document.getElementById("city").value}&type=${document.getElementById("type").value}`,
  );
  const sel = document.getElementById("district");
  const keep = sel.value;
  sel.innerHTML = "";
  sel.appendChild(el("option", { value: "" }, "全部"));
  for (const d of res.districts)
    sel.appendChild(el("option", { value: d }, d));
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}

// ---------- table ----------
function measureTextWidth(
  text,
  font = "14px ui-sans-serif,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Noto Sans TC,Helvetica Neue,Arial",
) {
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d");
  ctx.font = font;
  return ctx.measureText(text || "").width;
}
function computeColWidths(header, rows) {
  const samples = rows.slice(0, 80);
  const specialWide = new Set(["土地位置建物門牌", "備註", "建案名稱"]);
  return header.map((h, i) => {
    let max = measureTextWidth(String(h));
    for (const r of samples) {
      const w = measureTextWidth(String(r[i] || ""));
      if (w > max) max = w;
    }
    let minW = 90,
      maxW = 240;
    if (specialWide.has(h)) {
      minW = 180;
      maxW = 380;
    }
    if (
      ["鄉鎮市區", "交易年月日", "建築完成年月", "移轉層次"].includes(h)
    ) {
      minW = 120;
      maxW = 220;
    }
    const numeric =
      samples.length &&
      samples.every((r) => /^\s*[\d.,-]*\s*$/.test(String(r[i] || "")));
    if (numeric) {
      minW = 80;
      maxW = Math.min(maxW, 120);
    }
    const padding = 28;
    const w = Math.min(maxW, Math.max(minW, max + padding));
    return Math.round(w);
  });
}
function renderTable(header, rows) {
  const container = document.getElementById("table");
  const table = el("table");
  const widths = computeColWidths(header, rows);
  const colgroup = el("colgroup");
  widths.forEach((w) =>
    colgroup.appendChild(el("col", { style: `width:${w}px` })),
  );
  colgroup.appendChild(el("col", { style: "width:70px" })); // 操作欄
  table.appendChild(colgroup);

  const thead = el("thead");
  const trh = el("tr");
  header.forEach((h, idx) => {
    const th = el("th", {}, "");
    const inner = el("div", { class: "thwrap", title: h }, h);
    th.appendChild(inner);
    // if (idx === 0) th.classList.add("sticky-left"); // 移除第一欄黏貼
    trh.appendChild(th);
  });
  const thOp = el("th", { class: "sticky-right" }, "操作");
  trh.appendChild(thOp);
  thead.appendChild(trh);
  table.appendChild(thead);

  const tbody = el("tbody");
  for (const row of rows) {
    const tr = el("tr");
    row.forEach((cell, idx) => {
      const td = el("td", {}, "");
      const div = el(
        "div",
        { class: "cell", title: String(cell || "") },
        String(cell || ""),
      );
      td.appendChild(div);
      // if (idx === 0) td.classList.add("sticky-left"); // 移除第一欄黏貼
      tr.appendChild(td);
    });
    const idx = header.indexOf("編號");
    const id = idx >= 0 ? row[idx] : "";
    const btn = el("button", { "data-id": id, class: "nowrap" }, "查看");
    btn.onclick = () => loadDetail(id); // 彈窗
    const op = el("td", { class: "sticky-right" }, btn);
    tr.appendChild(op);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.innerHTML = "";
  container.appendChild(table);
}

// ---------- queries ----------
async function query(page = 1) {
  const city = document.getElementById("city").value;
  const type = document.getElementById("type").value;
  const limit = document.getElementById("limit").value;
  const keyword = encodeURIComponent(
    document.getElementById("keyword").value.trim(),
  );
  const district = encodeURIComponent(
    document.getElementById("district").value || "",
  );
  
  // 房地與土地篩選參數（僅不動產買賣時使用）
  let filterParams = '';
  if (type === 'a') {
    const includeBuilding = document.getElementById("includeBuilding").checked;
    const includeLand = document.getElementById("includeLand").checked;
    filterParams = `&includeBuilding=${includeBuilding}&includeLand=${includeLand}`;
  }
  
  const data = await fetchJSON(
    `/api/list?city=${city}&type=${type}&district=${district}&page=${page}&limit=${limit}&keyword=${keyword}${filterParams}`,
  );
  CURRENT = { page: data.page, total: data.total, limit: data.limit };
  renderTable(data.header, data.rows);
  document.getElementById("pageInfo").textContent =
    `第 ${data.page} / ${Math.max(1, Math.ceil(data.total / data.limit))} 頁（共 ${data.total} 筆）`;
}

// ===== Modal helpers =====
const modal = document.getElementById("modal");
const modalBody = document.getElementById("modalBody");
const modalBackdrop = document.getElementById("modalBackdrop");
const modalCloseBtn = document.getElementById("modalClose");

function openModal() {
  modalBackdrop.style.display = "block";
  modal.style.display = "flex";
  document.body.style.overflow = "hidden";
}
function closeModal() {
  modal.style.display = "none";
  modalBackdrop.style.display = "none";
  document.body.style.overflow = "";
  modalBody.innerHTML = "";
}
modalCloseBtn.addEventListener("click", closeModal);
modalBackdrop.addEventListener("click", closeModal);
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

// 依視窗寬度決定每列擺幾組 label+value
function getKVColsPerRow() {
  const w = window.innerWidth;
  if (w >= 1200) return 3; // 寬：3 組
  if (w >= 768) return 2; // 中：2 組
  return 1; // 窄：1 組
}

// ---------- detail（彈窗 + 多欄 KV） ----------
async function loadDetail(id) {
  const city = document.getElementById("city").value;
  const type = document.getElementById("type").value;
  const data = await fetchJSON(
    `/api/detail?city=${city}&type=${type}&id=${encodeURIComponent(id)}`,
  );

  const wrap = el("div", {});
  wrap.appendChild(renderKV(data.header, data.row, getKVColsPerRow()));

  if (data.details?.land?.length) {
    wrap.appendChild(el("h4", {}, "土地明細"));
    for (const r of data.details.land)
      wrap.appendChild(
        renderKV(data.details.landHeader, r, getKVColsPerRow()),
      );
  }
  if (data.details?.build?.length) {
    wrap.appendChild(el("h4", {}, "建物明細"));
    for (const r of data.details.build)
      wrap.appendChild(
        renderKV(data.details.buildHeader, r, getKVColsPerRow()),
      );
  }
  if (data.details?.park?.length) {
    wrap.appendChild(el("h4", {}, "車位明細"));
    for (const r of data.details.park)
      wrap.appendChild(
        renderKV(data.details.parkHeader, r, getKVColsPerRow()),
      );
  }

  modalBody.innerHTML = "";
  modalBody.appendChild(wrap);
  openModal();
}

// 多欄 KV：一列可擺 N 組（label+value）
function renderKV(header, row, colsPerRow = 3) {
  const tbl = el("table", { class: "kv-table" });
  const tb = el("tbody");

  for (let i = 0; i < header.length; i += colsPerRow) {
    const tr = el("tr");
    for (let j = 0; j < colsPerRow; j++) {
      const idx = i + j;
      if (idx < header.length) {
        tr.appendChild(
          el(
            "th",
            { class: "kv-label", title: header[idx] },
            header[idx],
          ),
        );
        const val = row[idx] ?? "";
        tr.appendChild(
          el(
            "td",
            { class: "kv-value", title: String(val) },
            String(val),
          ),
        );
      } else {
        tr.appendChild(el("th", { class: "kv-label" }, ""));
        tr.appendChild(el("td", { class: "kv-value" }, ""));
      }
    }
    tb.appendChild(tr);
  }

  tbl.appendChild(tb);
  return tbl;
}

// ---------- events ----------
// 原本的首次上傳
document.getElementById("uploadBtn").onclick = async () => {
  const f = document.getElementById("zipfile").files[0];
  if (!f) return alert("請先選擇 ZIP 檔");
  try {
    const r = await uploadZipWithProgress(f);
    document.getElementById("uploadStatus").textContent = "上傳完成";
    const periodText = (r.periodFriendly || r.period || "").trim();
    if (periodText)
      document.getElementById("period").textContent = periodText;
    await loadManifest();
    show("uploadCard", false);
    show("browser", true);
  } catch (e) {
    document.getElementById("uploadStatus").textContent =
      "失敗：" + e.message;
  }
};

// 新增：重新上傳 ZIP（在查詢列）
document.getElementById("reuploadTrigger").onclick = () => {
  document.getElementById("zipReupload").click();
};
document
  .getElementById("zipReupload")
  .addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const r = await uploadZipWithProgress(f, {
        progressId: "reupProgress",
        statusId: "reupStatus",
      });
      document.getElementById("reupStatus").textContent = "上傳完成";
      const periodText = (r.periodFriendly || r.period || "").trim();
      if (periodText)
        document.getElementById("period").textContent = periodText;
      await loadManifest();
      show("uploadCard", false);
      show("browser", true);
      await query(1); // 重新載入列表
    } catch (err) {
      document.getElementById("reupStatus").textContent =
        "失敗：" + err.message;
    } finally {
      e.target.value = ""; // 清空，方便再次選同一檔
    }
  });

// 拖放首次上傳
const dz = document.getElementById("dropzone");
["dragenter", "dragover"].forEach((ev) =>
  dz.addEventListener(ev, (e) => {
    e.preventDefault();
    dz.classList.add("drag");
  }),
);
["dragleave", "drop"].forEach((ev) =>
  dz.addEventListener(ev, (e) => {
    e.preventDefault();
    dz.classList.remove("drag");
  }),
);
dz.addEventListener("drop", async (e) => {
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f && f.name.toLowerCase().endsWith(".zip")) {
    try {
      const r = await uploadZipWithProgress(f);
      const periodText = (r.periodFriendly || r.period || "").trim();
      if (periodText)
        document.getElementById("period").textContent = periodText;
      await loadManifest();
      show("uploadCard", false);
      show("browser", true);
    } catch (err) {
      document.getElementById("uploadStatus").textContent =
        "失敗：" + err.message;
    }
  }
});

document.getElementById("city").onchange = async () => {
  await loadDistricts();
  query(1);
};
document.getElementById("type").onchange = async () => {
  await loadDistricts();
  
  // 顯示/隱藏房地與土地篩選器（僅不動產買賣顯示）
  const filterGroup = document.getElementById("landBuildingFilter");
  const type = document.getElementById("type").value;
  if (type === 'a') {
    filterGroup.classList.remove('hidden');
  } else {
    filterGroup.classList.add('hidden');
  }
  
  query(1);
};
document.getElementById("district").onchange = () => query(1);
document.getElementById("go").onclick = () => query(1);
document.getElementById("includeBuilding").onchange = () => query(1);
document.getElementById("includeLand").onchange = () => query(1);
document.getElementById("prev").onclick = () => {
  if (CURRENT.page > 1) query(CURRENT.page - 1);
};
document.getElementById("next").onclick = () => {
  const maxPage = Math.max(1, Math.ceil(CURRENT.total / CURRENT.limit));
  if (CURRENT.page < maxPage) query(CURRENT.page + 1);
};

// ---------- toast & global error ----------
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.style.display = "block";
  setTimeout(() => (t.style.display = "none"), 5000);
}
window.addEventListener("error", (e) => {
  console.error("window error", e);
  toast("前端錯誤：" + (e.message || e.error));
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("unhandledrejection", e.reason);
  toast("未處理的錯誤：" + (e.reason?.message || e.reason || ""));
});

// ---------- init ----------
(async () => {
  try {
    const m = await fetchJSON("/api/manifest");
    if (m && m.files && Object.keys(m.files).length) {
      document.getElementById("period").textContent =
        m.periodFriendly || m.period || "";
      await loadManifest();
      show("uploadCard", false);
      show("browser", true);
      
      // 初始設定篩選器顯示狀態
      const filterGroup = document.getElementById("landBuildingFilter");
      const type = document.getElementById("type").value;
      if (type !== 'a') {
        filterGroup.classList.add('hidden');
      }
    } else {
      show("browser", false);
      show("uploadCard", true);
    }
  } catch {
    show("browser", false);
    show("uploadCard", true);
  }
})();
