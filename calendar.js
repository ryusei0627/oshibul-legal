// 推しブル Web カレンダー本体 / B 案デザイン (= 半券モチーフ + 丸ゴシック)
//   設計書 v11.1 (= docs/web-calendar-phase-d-spec-v2.md) + デザイン B 案 (= 推し活ポップ) 準拠
//   - 全描画は textContent (= innerHTML 禁止 / XSS 完全遮断)
//   - admission_benefits: 配列のみ受容 / 5 件上限 / 50 字上限 / リンク化禁止
//   - ticket_types: 配列のみ受容 / 10 件上限 / name 100 字上限 / https URL のみ
//   - Supabase 通信は anon key + RPC 2 種のみ (= 直接テーブル SELECT 不可)
//   - inline <script> 禁止 (= CSP 整合 / calendar.html から defer 読み込み)

(function () {
  var SUPABASE_URL = "https://hshedudijjqauvpdmwhg.supabase.co";
  var SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhzaGVkdWRpampxYXV2cGRtd2hnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE5Mjc5NzksImV4cCI6MjA4NzUwMzk3OX0.xrRRJwMThL0em8NAPnQMDFcR1qtQkHyGYWWNSFRZxRk";
  // Codex B 案突合 軽微 #1 反映: ヒーロー画像は Supabase host 限定 (= CSP img-src と一致)
  var SUPABASE_IMG_PREFIX = SUPABASE_URL + "/";

  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
  var MONTH_JA = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];

  // event_type → カテゴリ (= 現行 DB schema 準拠 / EventTypeBadge.tsx と同色)
  //   src/lib/types.ts L5: "taiban" | "shusai" | "oneman" | "release" | "festival" | "other"
  //   src/components/calendar/EventTypeBadge.tsx の text カラーを採用 (= 背景は color + "1F" で 12% 透過)
  var EVENT_CAT = {
    taiban:   { label: "対バン",   color: "#2563EB" },
    shusai:   { label: "主催",     color: "#D61E62" },
    oneman:   { label: "ワンマン", color: "#7C3AED" },
    release:  { label: "リリイベ", color: "#D97706" },
    festival: { label: "フェス",   color: "#16A34A" },
    other:    { label: "その他",   color: "#6B3A52" }
  };
  var DEFAULT_CAT = { label: "その他", color: "#6B3A52" };

  var MAX_BENEFITS_COUNT = 5;
  var MAX_BENEFIT_LENGTH = 50;
  var MAX_TICKET_TYPES_COUNT = 10;
  var MAX_TICKET_NAME_LENGTH = 100;

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

  function parseDate(iso) {
    if (!iso) return null;
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return null;
      return d;
    } catch (e) {
      return null;
    }
  }

  function formatTimeRange(startIso, endIso) {
    function hm(iso) {
      var d = parseDate(iso);
      if (!d) return null;
      var h = String(d.getHours()).padStart(2, "0");
      var min = String(d.getMinutes()).padStart(2, "0");
      return h + ":" + min;
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

  // 料金: 複数チケット縦リスト (= 半券モチーフ維持 / 利用者判断 2026-06-23 A 案)
  function renderTicketTypes(parent, raw) {
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
      box.appendChild(el("div", "tickets-empty", "料金未設定"));
      parent.appendChild(box);
      return;
    }

    var ul = el("ul", "tickets-list");
    safeTicketTypes.forEach(function (t) {
      var li = el("li", "tickets-item");

      li.appendChild(el("span", "tickets-name", t.name));

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
      var li = el("li");
      li.appendChild(el("span", "ben-mark", "♥"));
      li.appendChild(el("span", "ben-text", text));
      ul.appendChild(li);
    });
    box.appendChild(ul);
    parent.appendChild(box);
  }

  // ヒーロー
  //   画像あり (= Supabase host 配信) → polaroid 枠 + 画像 + グループ名 (= B 案 polaroid)
  //   画像なし → polaroid 枠なし / グループ名だけシンプル表示 (= 利用者 FB#1 / 2026-06-23)
  function renderHero(group) {
    var hasImage = typeof group.image_url === "string" && group.image_url.indexOf(SUPABASE_IMG_PREFIX) === 0;

    function buildEyebrow() {
      var eyebrow = el("div", "eyebrow");
      eyebrow.appendChild(el("span", null, "♡"));
      eyebrow.appendChild(el("span", null, "公式カレンダー"));
      eyebrow.appendChild(el("span", null, "♡"));
      return eyebrow;
    }

    if (!hasImage) {
      // テキストヒーロー (polaroid 枠なし / 画像領域もなし)
      var textHero = el("div", "hero-text");
      textHero.appendChild(buildEyebrow());
      textHero.appendChild(el("h1", "name", group.name || "(名称未設定)"));
      return textHero;
    }

    // polaroid ヒーロー (画像あり)
    var hero = el("div", "hero");
    var wrap = el("div", "image-wrap");
    var img = document.createElement("img");
    img.className = "image";
    img.src = group.image_url;
    img.alt = "";
    wrap.appendChild(img);
    hero.appendChild(wrap);

    var meta = el("div", "meta");
    meta.appendChild(buildEyebrow());
    meta.appendChild(el("h1", "name", group.name || "(名称未設定)"));
    hero.appendChild(meta);

    return hero;
  }

  // 月見出し (= 直近イベントの月 / 無ければ今月)
  function renderMonthBar(events) {
    var d = null;
    if (events && events.length > 0) d = parseDate(events[0].start_at);
    if (!d) d = new Date();
    var bar = el("div", "month-bar");
    bar.appendChild(el("span", "month", MONTH_JA[d.getMonth()]));
    bar.appendChild(el("span", "year", String(d.getFullYear())));
    return bar;
  }

  // イベントカード (= B 案 / 半券 + 本文)
  function renderEvent(event) {
    var d = parseDate(event.start_at);
    var wd = d ? d.getDay() : -1; // 0=日, 6=土
    var card = el("div", "event");
    if (wd === 6) card.classList.add("is-sat");
    else if (wd === 0) card.classList.add("is-sun");

    // 半券
    var stub = el("div", "stub");
    if (d) {
      stub.appendChild(el("div", "stub-month", (d.getMonth() + 1) + "月"));
      stub.appendChild(el("div", "stub-day", String(d.getDate())));
      stub.appendChild(el("div", "stub-wd", "(" + WEEKDAYS[wd] + ")"));
    } else {
      stub.appendChild(el("div", "stub-day", "?"));
    }
    card.appendChild(stub);

    // 本文
    var body = el("div", "body");

    var head = el("div", "head");
    var cat = EVENT_CAT[event.event_type] || DEFAULT_CAT;
    var chip = el("span", "chip");
    chip.style.background = cat.color + "1F";
    var dot = el("span", "dot");
    dot.style.background = cat.color;
    chip.appendChild(dot);
    var chipLabel = el("span", "chip-label", cat.label);
    chipLabel.style.color = cat.color;
    chip.appendChild(chipLabel);
    head.appendChild(chip);
    body.appendChild(head);

    body.appendChild(el("h3", "title", event.title || "(タイトル未設定)"));

    var rows = el("div", "rows");
    addRow(rows, "会場", event.venue);
    addRow(rows, "開場", formatTimeRange(event.open_at, null));
    addRow(rows, "公演", formatTimeRange(event.performance_start_at, event.performance_end_at));
    addRow(rows, "特典会", formatTimeRange(event.meet_greet_start_at, event.meet_greet_end_at));
    if (rows.children.length > 0) body.appendChild(rows);

    renderTicketTypes(body, event.ticket_types);
    renderBenefits(body, event.admission_benefits);

    // Codex B 案突合 軽微 #2: event.performance_order は RPC 戻り値にあるが、
    // B 案デザインでは表示意図なし (= イベント並び順は RPC 側 start_at ASC で確定)
    // → 意図的に未使用 / 将来表示要望が出たら本ファイルで追加

    card.appendChild(body);
    return card;
  }

  function renderEvents(parent, events) {
    if (!events || events.length === 0) {
      var empty = el("div", "empty");
      empty.appendChild(el("div", "icon", "🌷"));
      empty.appendChild(el("div", null, "予定がありません"));
      parent.appendChild(empty);
      return;
    }
    var list = el("div", "events");
    events.forEach(function (ev) {
      list.appendChild(renderEvent(ev));
    });
    parent.appendChild(list);
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
      // Codex B 案突合 軽微 #4: ローディング解除後も aria 構造を保持 (= スクリーンリーダー対応)
      root.setAttribute("role", "main");
      root.setAttribute("aria-label", "公式カレンダー");
      root.removeAttribute("aria-live");
      root.appendChild(renderHero(group));
      root.appendChild(renderMonthBar(events));
      renderEvents(root, events);

      if (group.name) document.title = group.name + " 公式カレンダー / 推しブル";
    } catch (e) {
      renderError("読み込みに失敗しました。時間をおいて再度お試しください。");
    }
  }

  if (window.supabase) {
    main();
  } else {
    window.addEventListener("DOMContentLoaded", main);
  }
})();
