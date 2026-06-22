// D-20260619-02 / D-20260620-01 / 070: 推しブル Web カレンダー本体ロジック
//   設計書 v7 (= docs/web-calendar-phase-d-spec-v2.md) 準拠
//   - 全描画は textContent (= innerHTML 禁止 / XSS 完全遮断)
//   - admission_benefits 描画は 配列のみ受容 / 5 件上限 / 50 字上限 / リンク化禁止
//   - Supabase 通信は anon key + RPC 2 種のみ (= 直接テーブル SELECT 不可)
//   - 本番値固定: anon key は公開前提 (= RLS + RPC 経由でのみ意味を持つ)
//
// v7 重要事項:
//   - 本ファイルは calendar.html 側から `<script src="calendar.js" defer></script>` で
//     CSP `script-src 'self' https://cdn.jsdelivr.net` 整合のもと読み込まれる。
//   - inline `<script>` での実装は CSP でブロックされるため禁止。

(function () {
  var SUPABASE_URL = "https://hshedudijjqauvpdmwhg.supabase.co";
  var SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhzaGVkdWRpampxYXV2cGRtd2hnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE5Mjc5NzksImV4cCI6MjA4NzUwMzk3OX0.xrRRJwMThL0em8NAPnQMDFcR1qtQkHyGYWWNSFRZxRk";

  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
  var EVENT_TYPE_LABELS = {
    live: "ライブ",
    event: "イベント",
    release: "リリース",
    birthday: "生誕祭",
    anniversary: "周年",
    meetgreet: "特典会",
    other: "その他"
  };
  var MAX_BENEFITS_COUNT = 5;
  var MAX_BENEFIT_LENGTH = 50;
  // D-20260622-02 / 073 / 設計書 v10: チケット種別描画制約
  var MAX_TICKET_TYPES_COUNT = 10;       // 件数上限 (= DoS 防御 / 戻り値も RPC 側 LIMIT 10 で二重)
  var MAX_TICKET_NAME_LENGTH = 100;      // name 文字数上限 (= DB CHECK と同等)

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function renderError(message) {
    var root = document.getElementById("root");
    root.className = "error";
    root.replaceChildren();
    var icon = el("div", "icon", "📅");
    var msg = el("div", null, message);
    root.appendChild(icon);
    root.appendChild(msg);
  }

  function formatDate(iso) {
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return { date: "", weekday: "" };
      var m = d.getMonth() + 1;
      var day = d.getDate();
      return { date: m + "/" + day, weekday: WEEKDAYS[d.getDay()] };
    } catch (e) {
      return { date: "", weekday: "" };
    }
  }

  function formatTimeRange(startIso, endIso) {
    function hm(iso) {
      if (!iso) return null;
      try {
        var d = new Date(iso);
        if (isNaN(d.getTime())) return null;
        var h = String(d.getHours()).padStart(2, "0");
        var min = String(d.getMinutes()).padStart(2, "0");
        return h + ":" + min;
      } catch (e) {
        return null;
      }
    }
    var s = hm(startIso);
    var e = hm(endIso);
    if (s && e) return s + " 〜 " + e;
    if (s) return s + " 〜";
    if (e) return "〜 " + e;
    return null;
  }

  function addRow(parent, label, value) {
    if (value == null || value === "") return;
    var row = el("div", "row");
    row.appendChild(el("span", "row-label", label));
    row.appendChild(el("span", "row-value", value));
    parent.appendChild(row);
  }

  // D-20260622-02 / 設計書 v10 §「ticket_types JSONB 描画制約」
  //   - protocol === 'https:' のみ許可 (= javascript:/data:/http:/file: 等遮断)
  //   - new URL() 正規化後の href を採用 (= proto smuggling 防止)
  function sanitizeTicketUrl(url) {
    if (typeof url !== "string" || url.length === 0) return null;
    var parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return null;
    }
    if (parsed.protocol !== "https:") return null;
    return parsed.href;
  }

  function renderTicketTypes(parent, raw) {
    // 設計書 v10: ticket_types JSONB 配列を描画 (= 旧 ticket_price 撤去)
    //   - 配列のみ受容 / 件数 + 名前長サニタイズ
    //   - price は INTEGER + 非負のみ
    //   - 「料金未設定 / 無料 / 金額表示」3 出し分け
    var ticketTypes = Array.isArray(raw) ? raw : [];

    var safeTicketTypes = ticketTypes
      .slice(0, MAX_TICKET_TYPES_COUNT)
      .map(function (t) {
        var name = String(t && t.name != null ? t.name : "").slice(0, MAX_TICKET_NAME_LENGTH);
        var price = (t && Number.isInteger(t.price) && t.price >= 0) ? t.price : null;
        var ticketUrl = sanitizeTicketUrl(t && t.ticket_url);
        return { name: name, price: price, ticket_url: ticketUrl };
      })
      .filter(function (t) { return t.name.length > 0 && t.price !== null; });

    var box = el("div", "tickets");
    box.appendChild(el("div", "tickets-label", "料金"));

    if (safeTicketTypes.length === 0) {
      // event_ticket_types 空 (または全て不正) → 「料金未設定」
      box.appendChild(el("div", "tickets-empty", "料金未設定"));
      parent.appendChild(box);
      return;
    }

    var ul = el("ul", "tickets-list");
    safeTicketTypes.forEach(function (t) {
      var li = el("li", "tickets-item");

      var nameSpan = el("span", "tickets-name", t.name);
      li.appendChild(nameSpan);

      var priceSpan = el("span", "tickets-price");
      if (t.price === 0) {
        priceSpan.textContent = "無料";
        priceSpan.classList.add("free");
      } else {
        priceSpan.textContent = "¥" + t.price.toLocaleString("ja-JP");
      }
      li.appendChild(priceSpan);

      if (t.ticket_url) {
        var a = document.createElement("a");
        a.className = "tickets-link";
        a.href = t.ticket_url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = "購入はこちら →";
        li.appendChild(a);
      }

      ul.appendChild(li);
    });
    box.appendChild(ul);
    parent.appendChild(box);
  }

  function renderBenefits(parent, raw) {
    // 設計書 v6: 配列のみ受容 / String 化 / slice / filter / リンク化禁止
    if (!Array.isArray(raw)) return;
    var safeBenefits = raw
      .slice(0, MAX_BENEFITS_COUNT)
      .map(function (b) { return String(b == null ? "" : b).slice(0, MAX_BENEFIT_LENGTH); })
      .filter(function (b) { return b.length > 0; });
    if (safeBenefits.length === 0) return;

    var box = el("div", "benefits");
    box.appendChild(el("div", "ben-label", "入場特典"));
    var ul = el("ul");
    safeBenefits.forEach(function (text) {
      ul.appendChild(el("li", null, text));
    });
    box.appendChild(ul);
    parent.appendChild(box);
  }

  function renderGroupCard(group) {
    var card = el("div", "group-card");
    var swatch = el("div", "swatch");
    if (typeof group.color === "string" && /^#[0-9A-Fa-f]{6}$/.test(group.color)) {
      swatch.style.background = group.color;
    }
    card.appendChild(swatch);

    if (typeof group.image_url === "string" && group.image_url.indexOf("https://") === 0) {
      var img = document.createElement("img");
      img.className = "image";
      img.src = group.image_url;
      img.alt = "";
      card.appendChild(img);
    }

    var meta = el("div", "meta");
    meta.appendChild(el("div", "label", "公式カレンダー"));
    meta.appendChild(el("h1", "name", group.name || "(名称未設定)"));
    card.appendChild(meta);
    return card;
  }

  function renderEvent(event) {
    var wrap = el("div", "event");

    var dateRow = el("div", "date-row");
    var d = formatDate(event.start_at);
    dateRow.appendChild(el("span", "date", d.date));
    dateRow.appendChild(el("span", "weekday", d.weekday ? "(" + d.weekday + ")" : ""));
    var typeLabel = EVENT_TYPE_LABELS[event.event_type] || null;
    if (typeLabel) dateRow.appendChild(el("span", "type-tag", typeLabel));
    wrap.appendChild(dateRow);

    wrap.appendChild(el("h2", "title", event.title || "(タイトル未設定)"));

    addRow(wrap, "会場", event.venue);
    addRow(wrap, "開場", formatTimeRange(event.open_at, null));
    addRow(wrap, "公演", formatTimeRange(event.performance_start_at, event.performance_end_at));
    addRow(wrap, "特典会", formatTimeRange(event.meet_greet_start_at, event.meet_greet_end_at));

    // D-20260622-02 / 073 / 設計書 v10: 旧 event.ticket_price 撤去 / ticket_types リスト表示に置換
    renderTicketTypes(wrap, event.ticket_types);

    renderBenefits(wrap, event.admission_benefits);

    return wrap;
  }

  function renderEvents(events) {
    var root = document.getElementById("root");
    if (!events || events.length === 0) {
      var empty = el("div", "empty");
      empty.appendChild(el("div", "icon", "🌷"));
      empty.appendChild(el("div", null, "予定がありません"));
      var box = el("div");
      box.appendChild(empty);
      root.appendChild(box);
      return;
    }
    var list = el("div", "events");
    events.forEach(function (ev) {
      list.appendChild(renderEvent(ev));
    });
    root.appendChild(list);
  }

  async function main() {
    var params = new URLSearchParams(window.location.search);
    var groupId = params.get("group_id");
    if (!groupId || !UUID_RE.test(groupId)) {
      renderError("無効な URL です");
      return;
    }

    if (!window.supabase || typeof window.supabase.createClient !== "function") {
      renderError("読み込みに失敗しました。時間をおいて再度お試しください。");
      return;
    }

    try {
      var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

      var groupRes = await client.rpc("get_public_calendar_group", { p_group_id: groupId });
      if (groupRes.error || !Array.isArray(groupRes.data) || groupRes.data.length === 0) {
        renderError("カレンダーが見つかりません");
        return;
      }
      var group = groupRes.data[0];

      var eventsRes = await client.rpc("get_public_calendar_events", { p_group_id: groupId });
      var events = eventsRes.error || !Array.isArray(eventsRes.data) ? [] : eventsRes.data;

      var root = document.getElementById("root");
      root.className = "";
      root.replaceChildren();
      root.appendChild(renderGroupCard(group));
      renderEvents(events);

      if (group.name) document.title = group.name + " 公式カレンダー / 推しブル";
    } catch (e) {
      renderError("読み込みに失敗しました。時間をおいて再度お試しください。");
    }
  }

  // defer 読み込みのため DOMContentLoaded を待つ必要はない (= 解析完了後に実行される)
  // ただし Supabase SDK スクリプトも defer なので両方の評価順を保証するため一手間。
  if (window.supabase) {
    main();
  } else {
    window.addEventListener("DOMContentLoaded", main);
  }
})();
