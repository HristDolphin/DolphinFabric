/* ============================================================================
 * selfselect.js — 自绘文本选择器（接管 Android 系统 ActionMode）
 *
 * 为什么需要它:
 *   Android WebView 的文本选择由平台层实现。大面积拖选时,握住选区手柄在屏幕边缘
 *   拖动会诱发自动滚动,但系统 ActionMode 一浮现就打断拖拽,表现为「卡住 / 选区回缩」。
 *   真机实测确认:壳层 onPrepareActionMode 抑制无效;按住不弹浮条会破坏选字功能。
 *   → 唯一根治路径是接管触摸,完全自绘选择。
 *
 * 已验证的前提(真机 Redmi / Android 13 / WebView 104):
 *   1. touchstart 里 preventDefault() 能彻底阻止系统选择器(sel=[0,0],无浮条)
 *   2. 阻止后仍可主动 focus() + setSelectionRange,键盘正常弹出
 *   3. 镜像 div + Range.getClientRects() 能精确算出每行矩形
 *
 * 设计取舍:
 *   - 保留 textarea 负责输入/输入法/键盘,只接管「触摸与选择」
 *   - 长按**不猜用户要选什么**,只落光标并放出起点手柄(用户明确要求)
 *   - 滚动自实现(rAF + 边缘触发),完全绕开 ActionMode
 *   - 独立文件 + 开关,出问题一行关掉即回退原生行为
 * ==========================================================================*/
(function () {
  'use strict';

  /* ---------------- 开关 ---------------- */
  // 关闭时本文件不产生任何副作用,行为与原生完全一致
  const ENABLED = true;

  const CFG = {
    LONG_PRESS_MS: 480,     // 长按判定
    TAP_MAX_MOVE: 10,       // tap 允许的最大位移
    TAP_MAX_MS: 320,        // tap 允许的最长时间
    HANDLE_HIT: 30,         // 手柄命中半径(px)
    EDGE_ZONE: 52,          // 触发自动滚动的边缘区高度(px)
    SCROLL_MAX: 16,         // 自动滚动最大速度(px/帧)
    SCROLL_MIN: 2.2,        // 最小速度
    FRICTION: 0.94,         // 惯性衰减
    HL: 'rgba(139,124,255,0.34)',      // 选区高亮色
    HANDLE_R: 7,            // 手柄圆点半径
    HANDLE_STEM: 10         // 手柄竖杆长度
  };

  /* ---------------- 状态 ---------------- */
  const S = {
    anchor: -1, focus: -1,
    dragging: null,          // 'start' | 'end' | 'body' | null
    press: null,             // { x, y, t, timer, moved }
    lastTapAt: 0,
    lastTapPos: { x: 0, y: 0 },
    autoTimer: 0,
    autoDir: 0,
    inertia: 0,
    rafScroll: 0,
    mirror: null,
    inited: false
  };

  /* ---------------- DOM 引用 ---------------- */
  let ed = null;      // textarea
  let layer = null;   // 覆盖层容器（颜色块 + 手柄 + 浮条）
  let hlBox = null;   // 高亮色块容器
  let hStart = null;  // 起点手柄
  let hEnd = null;    // 终点手柄
  let bar = null;     // 浮条

  const q = s => document.querySelector(s);

  /* ---------------- 镜像层：字符 <-> 坐标 ---------------- */
  const Mirror = {
    box: null, inner: null, metrics: null, cachedVal: null, cachedW: 0,

    build() {
      if (!ed) return;
      if (this.box) this.box.remove();
      const cs = getComputedStyle(ed);
      const padL = parseFloat(cs.paddingLeft) || 0;
      const padR = parseFloat(cs.paddingRight) || 0;
      const padT = parseFloat(cs.paddingTop) || 0;
      const padB = parseFloat(cs.paddingBottom) || 0;
      /* ★ 宽度必须与 textarea 的内容宽度严格一致，否则折行位置不同 → 所有字符坐标全错。
       * textarea 是 box-sizing:border-box，其内容宽 = clientWidth - padL - padR。
       * 镜像盒子也声明 border-box，所以宽度要直接给 clientWidth（padding 从里面扣），
       * 这样内部内容区正好等于 textarea 的内容宽。
       * 早期误把 contentW 当盒子宽度又加了 border-box，内容区被 padding 再扣一次，
       * 比真实窄 32px → 多折 30 多行 → 选区高亮整体错位（用户反馈「范围不准」）。 */
      const boxW = Math.max(60, ed.clientWidth);

      const box = document.createElement('div');
      box.style.cssText = [
        'position:fixed', 'left:0', 'top:0', 'visibility:hidden',
        'pointer-events:none', 'z-index:-1', 'overflow:hidden', 'box-sizing:border-box',
        'width:' + boxW + 'px',
        'padding-top:' + padT + 'px',
        'padding-left:' + padL + 'px',
        'padding-right:' + padR + 'px',
        'font-family:' + cs.fontFamily,
        'font-size:' + cs.fontSize,
        'line-height:' + cs.lineHeight,
        'letter-spacing:' + cs.letterSpacing,
        'white-space:pre-wrap',
        'word-break:break-word',
        'overflow-wrap:break-word',
        'tab-size:' + (cs.tabSize || 8)
      ].join(';');

      const inner = document.createElement('div');
      inner.style.cssText = 'white-space:pre-wrap;word-break:break-word;overflow-wrap:break-word;';
      inner.textContent = ed.value;
      box.appendChild(inner);
      document.body.appendChild(box);

      this.box = box; this.inner = inner;
      this.cachedVal = ed.value; this.cachedW = boxW;
      this.cachedKey = this.styleKey();
      this.metrics = {
        padL, padT, padB,
        lineH: parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 16) * 1.6,
        contentW: boxW - padL - padR,
        fontSize: parseFloat(cs.fontSize) || 16
      };
      this.computeK(0);
      return this.metrics;
    },

    /* ★ 行距校正系数 k（解决「越往下偏越多」）
     * 实测:textarea 内容高 36270,镜像内容高 36263,行数都是 1230。
     * 说明 textarea 内部行距有极微小的舍入(每行差 0.0057px),而镜像用浮点行距。
     * 两者线性累积 → 滚到 95% 深度时高亮整体偏移约 7.6 CSS px。
     * 小字行数多、累积更久,所以「小字偏得多、大字偏得少」。
     * 用 (真实内容高 / 镜像内容高) 作为比例因子乘到所有镜像 y 上即可抵消。 */
    computeK(attempt) {
      if (!this.inner) { this.k = 1; return; }
      const padT = this.metrics ? this.metrics.padT : 0;
      const padB = this.metrics ? this.metrics.padB : 0;
      const taH = ed.scrollHeight - padT - padB;
      const mkH = this.inner.getBoundingClientRect().height;
      if (taH > 0 && mkH > 0) {
        this.k = taH / mkH;
      } else {
        this.k = 1;
      }
      // 刚改过 value 时 scrollHeight 可能滞后一帧，补算一次
      if (attempt < 2 && (taH <= 0 || mkH <= 0)) {
        const self = this;
        requestAnimationFrame(() => self.computeK(attempt + 1));
      }
    },

    /** 文本变了或宽度变了就重建 */
    /** 样式指纹：任何一项变化都必须重建镜像，否则折行结果与真实文本框不一致。
     * ★ 这是「选区位置偏移」的根因修复。
     * 早期 refreshIfNeeded 只比对 value 和 clientWidth。用户在设置里改了字号
     * （实测 line-height 从 29.48 变成 35.38），value/宽度都没变 → 镜像永不重建
     * → 仍按旧字号折行，每行字数与实际不同，越到后面偏移越大（实测满文本差 355 行）。 */
    styleKey() {
      if (!ed) return '';
      const cs = getComputedStyle(ed);
      return [
        cs.fontSize, cs.lineHeight, cs.fontFamily, cs.letterSpacing,
        cs.paddingLeft, cs.paddingRight, cs.paddingTop, cs.paddingBottom,
        cs.textIndent || '0', cs.wordSpacing || 'normal',
        Math.max(60, ed.clientWidth)
      ].join('|');
    },

    /** 文本变了、宽度变了、或字体度量变了就重建 */
    refreshIfNeeded() {
      if (!this.box) { this.build(); return; }
      const key = this.styleKey();
      if (this.cachedVal !== ed.value || this.cachedKey !== key) this.build();
    },

    /** 字符范围 → 行矩形数组（相对 textarea 内容区原点，未减 scrollTop） */
    /** 字符索引 → 内容坐标 y（相对镜像内容区原点）。用于按可视区裁剪 */
    charY(idx) {
      if (!this.inner || !this.inner.firstChild) return 0;
      const tn = this.inner.firstChild;
      const total = tn.nodeValue.length;
      const k = this.k || 1;
      if (idx <= 0) return 0;
      if (idx >= total) return this.inner.getBoundingClientRect().height * k;
      const base = this.inner.getBoundingClientRect();
      const r = document.createRange();
      r.setStart(tn, Math.min(idx, total - 1));
      r.setEnd(tn, Math.min(idx + 1, total));
      const rc = r.getClientRects()[0];
      if (!rc) return 0;
      return (rc.top - base.top) * k;
    },

    /** 内容 y → 字符索引（只按 y 二分，不做 x 精调，代价极低）。
     * 用来把「整段选区」裁到「可视区那几十行」，把每帧 getClientRects 的量
     * 从几千字符降到几百字符 —— 这是滚动掉帧的主要原因。 */
    charAtY(targetY) {
      if (!this.inner || !this.inner.firstChild) return 0;
      const tn = this.inner.firstChild;
      const total = tn.nodeValue.length;
      let lo = 0, hi = total;
      const base = this.inner.getBoundingClientRect();
      const lh = this.metrics.lineH;
      /* 入参是「校正后」的真实内容 y，二分时要比的是镜像原始 y，故先除回 k */
      const t = targetY / (this.k || 1);
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const r = document.createRange();
        r.setStart(tn, Math.min(mid, total - 1));
        r.setEnd(tn, Math.min(mid + 1, total));
        const rc = r.getClientRects()[0];
        const y = rc ? (rc.top - base.top) : (mid / Math.max(1, total) * this.inner.getBoundingClientRect().height);
        if (y + lh / 2 < t) lo = mid + 1; else hi = mid;
      }
      return Math.max(0, Math.min(lo, total));
    },

    rectsOf(a, b) {
      if (!this.inner || !this.inner.firstChild) return [];
      const tn = this.inner.firstChild;
      const len = tn.nodeValue.length;
      a = Math.max(0, Math.min(a, len));
      b = Math.max(0, Math.min(b, len));
      if (b <= a) return [];
      const r = document.createRange();
      r.setStart(tn, a); r.setEnd(tn, b);
      const base = this.inner.getBoundingClientRect();
      const out = [];
      const k = this.k || 1;
      const list = r.getClientRects();
      for (let i = 0; i < list.length; i++) {
        const rc = list[i];
        if (rc.width <= 0 && rc.height <= 0) continue;
        out.push({
          x: rc.left - base.left,
          /* y 乘以行距校正系数：抵消 textarea 内部行距舍入带来的累积偏移 */
          y: (rc.top - base.top) * k,
          w: Math.max(rc.width, 1),
          h: rc.height || this.metrics.lineH
        });
      }
      return out;
    },

    /** 坐标（clientX/Y）→ 字符偏移 */
    caretAt(clientX, clientY) {
      /* ★ 必须先确保镜像层已构建。
       * 早期版本此处只判空就 return 0，而镜像层原本只在 render() 里构建，
       * 首次长按时镜像层还不存在 → 永远返回 0 → 手柄画在第 0 行。 */
      this.refreshIfNeeded();
      if (!this.inner || !this.inner.firstChild) return 0;
      const tn = this.inner.firstChild;
      const total = tn.nodeValue.length;
      const base = this.inner.getBoundingClientRect();
      const edRect = ed.getBoundingClientRect();
      const cs = getComputedStyle(ed);
      const padT = parseFloat(cs.paddingTop) || 0;
      const padL = parseFloat(cs.paddingLeft) || 0;

      /* ★ 坐标系对齐（关键）：
       * 镜像层显示全文且不滚动，它的「内容坐标」从 0 开始；
       * textarea 是滚动的，其内容坐标 = clientY - 编辑器顶 - paddingTop + scrollTop。
       * 早期漏了 scrollTop，导致算出的字符落在视口上方（手柄跑到 -549px）。
       * 再除以行距校正系数 k：把「真实内容 y」换回镜像坐标系，才能与 yOf 比较。 */
      const relY = (clientY - edRect.top - padT + ed.scrollTop) / (this.k || 1);
      const relX = clientX - edRect.left - padL;

      const lh = this.metrics.lineH;

      /* 取第 idx 个字符的几何。★ 关键：若该字符是换行符，getClientRects() 返回空，
       * 早期版本遇到空就 `hi = mid - 1`，导致二分一路向左收敛，
       * 算出的字符严重偏前（表现为手柄跑到第 0 行、top 变成个位数）。
       * 现改为向后最多 3 个、再向前最多 3 个寻找可见字符。 */
      const yOf = idx => {
        const probe = i0 => {
          if (i0 < 0 || i0 >= total) return null;
          const r = document.createRange();
          r.setStart(tn, i0);
          r.setEnd(tn, Math.min(i0 + 1, total));
          const rc = r.getClientRects()[0];
          if (!rc || rc.height <= 0) return null;
          return { y: rc.top - base.top, x: rc.left - base.left, w: rc.width, h: rc.height || lh };
        };
        for (let k = 0; k <= 3; k++) { const g = probe(idx + k); if (g) return g; }
        for (let k = 1; k <= 3; k++) { const g = probe(idx - k); if (g) return g; }
        return null;
      };

      // 1) 按 y 二分找到最接近的行
      let lo = 0, hi = total, best = 0, bestD = Infinity;
      for (let it = 0; it < 24 && lo <= hi; it++) {
        const mid = (lo + hi) >> 1;
        const g = yOf(mid);
        if (!g) { hi = mid - 1; continue; }
        const cy = g.y + g.h / 2;
        const d = Math.abs(cy - relY);
        if (d < bestD) { bestD = d; best = mid; }
        if (cy < relY) lo = mid + 1; else hi = mid - 1;
      }

      // 2) 在最佳行内按 x 精调（前后各扫 120 字足够覆盖一行）
      let guess = best;
      let bestX = Infinity;
      const from = Math.max(0, best - 120), to = Math.min(total, best + 120);
      const bestG = yOf(best);
      const lineY = bestG ? bestG.y : 0;
      for (let i = from; i <= to; i++) {
        const g = yOf(i);
        if (!g) continue;
        if (Math.abs(g.y - lineY) > lh * 0.6) continue;   // 不同行跳过
        const dx = Math.abs(g.x - relX);
        if (dx < bestX) { bestX = dx; guess = i; }
      }
      return Math.max(0, Math.min(guess, total));
    }
  };

  /* ---------------- 绘制 ---------------- */
  function ensureDom() {
    if (!ed) return;
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'ss-layer';
      hlBox = document.createElement('div');
      hlBox.className = 'ss-hl';
      hStart = document.createElement('div');
      hStart.className = 'ss-handle ss-handle-start';
      hEnd = document.createElement('div');
      hEnd.className = 'ss-handle ss-handle-end';
      bar = document.createElement('div');
      bar.className = 'ss-bar';
      layer.appendChild(hlBox);
      layer.appendChild(hStart);
      layer.appendChild(hEnd);
      layer.appendChild(bar);
      // 挂到 editor-body 里，跟随编辑器定位
      const host = ed.parentNode || document.body;
      host.appendChild(layer);
    }
    syncLayerBox();
  }

  /** 覆盖层与 textarea 的可视区对齐 */
  function syncLayerBox() {
    if (!layer || !ed) return;
    const host = layer.parentNode;
    const er = ed.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    layer.style.left = (er.left - hr.left) + 'px';
    layer.style.top = (er.top - hr.top) + 'px';
    layer.style.width = ed.clientWidth + 'px';
    layer.style.height = ed.clientHeight + 'px';
  }

  function render() {
    if (!ed || !layer) return;
    syncLayerBox();
    const active = S.anchor >= 0 && S.focus >= 0 && S.anchor !== S.focus;
    const hasPoint = S.anchor >= 0;

    hlBox.innerHTML = '';
    hStart.style.display = 'none';
    hEnd.style.display = 'none';
    if (!hasPoint) { hideBar(); return; }

    Mirror.refreshIfNeeded();
    const cs = getComputedStyle(ed);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padT = parseFloat(cs.paddingTop) || 0;
    /* 层坐标原点 = 编辑器左边缘，而镜像 rectsOf 返回的是「相对镜像内容区」的 x，
     * 镜像盒贴在视口 left:0，所以换算到层坐标要减掉编辑器自身的 left。桌面端编辑器
     * 不在 0 位置时若不减就会整体右移（手机端 left=0 掩盖了这个问题）。 */
    const edLeft = ed.getBoundingClientRect().left;

    const start = Math.min(S.anchor, S.focus >= 0 ? S.focus : S.anchor);
    const end = Math.max(S.anchor, S.focus >= 0 ? S.focus : S.anchor);

    /* 高亮：只画可视区那几十行。
     * ★ 先把字符区间裁到可视区，再交给 rectsOf —— 否则选了几千字时每帧都要对
     * 几千字符跑 getClientRects，滚动必然掉帧（用户反馈「滑动播放出现跳帧卡顿」）。
     * 上下各留一行余量，避免滚动时边缘闪烁。 */
    if (active) {
      const viewTop = ed.scrollTop;
      const viewBottom = viewTop + ed.clientHeight;
      const visA = Mirror.charAtY(viewTop - padT - Mirror.metrics.lineH);
      const visB = Mirror.charAtY(viewBottom - padT + Mirror.metrics.lineH);
      const cutA = Math.max(start, Math.min(visA, end));
      const cutB = Math.min(end, Math.max(visB, start));
      const rects = (cutB > cutA) ? Mirror.rectsOf(cutA, cutB) : [];
      const frag = document.createDocumentFragment();
      /* ★ 高亮块按「整行高度」铺满，而不是用文字 line-box 的高度。
       * 实测：字号 19.125 / 行高 35.38 时，getClientRects 返回的文字框只有 27.4 高，
       * 直接用它会让相邻行之间留 8px 缝隙 —— 多行选择看起来是断裂的色条，
       * 观感上就像「选择框位置不准」。
       * 做法：块高取行高，top 往上补掉 (行高 - 文字框高)/2，让整行连续覆盖。 */
      const maxLineH = Mirror.metrics ? Mirror.metrics.lineH : 0;
      const inkShift = inkCenterShift();
      for (const r of rects) {
        const hUse = Math.max(r.h, maxLineH || r.h);
        const top = r.y + padT - viewTop - (hUse - r.h) / 2 + inkShift;
        if (top + hUse < -40 || top > ed.clientHeight + 40) continue;   // 视口外跳过
        const d = document.createElement('div');
        d.className = 'ss-rect';
        d.style.left = (r.x + padL - edLeft) + 'px';
        d.style.top = top + 'px';
        d.style.width = r.w + 'px';
        d.style.height = hUse + 'px';
        frag.appendChild(d);
      }
      hlBox.appendChild(frag);
    }

    // 手柄位置：起点在 anchor 字符起点，终点在 focus 字符末端
    const posOf = (idx, isEnd) => {
      const rs = Mirror.rectsOf(idx, Math.min(idx + 1, ed.value.length));
      if (!rs.length) return null;
      const r = rs[0];
      const top = r.y + padT - ed.scrollTop;
      // 起点靠左，终点靠右（贴合视觉习惯）
      const x = isEnd ? (r.x + padL - edLeft + r.w) : (r.x + padL - edLeft);
      return { x, y: top, h: r.h };
    };

    const pa = posOf(S.anchor, false);
    const pf = S.focus >= 0 ? posOf(S.focus, true) : null;

    /* 只有「真的有区间」时才画手柄。
     * 非选择状态（anchor === focus）不画任何手柄，只留 textarea 自己的原生光标 ——
     * 用户反馈「非选择状态的光标跟原生不一样」，原生光标由 syncNative() 定位，
     * 外观交给系统，视觉上才一致。
     *
     * ★ 必须对 posOf 的返回值判空：端点字符若恰好取不到 rects
     * （换行符边界、索引越界、镜像尚未布局完），posOf 会返回 null，
     * 直接丢给 placeHandle 会抛 TypeError 让整个 render 中断。
     * 此时宁可不画对应手柄，也不能让高亮与浮条一起失效。 */
    if (active) {
      const sPos = (S.anchor > S.focus) ? pf : pa;
      const ePos = (S.anchor > S.focus) ? pa : pf;
      if (sPos) { placeHandle(hStart, sPos); hStart.style.display = 'block'; }
      else hStart.style.display = 'none';
      if (ePos) { placeHandle(hEnd, ePos); hEnd.style.display = 'block'; }
      else hEnd.style.display = 'none';
    }

    if (active) showBar(start, end);
    else hideBar();
  }

  /* ★ 墨迹中心修正量
   * getClientRects 给出的是「字体度量盒」（高 = 1.434 × 字号），它对行盒是居中的；
   * 但中文字符的实际墨迹（em box）在度量盒内部并不居中，而是略偏下。
   * 像素实测（Songti SC / SimSun）：
   *   字号 14 → 墨迹中心比行盒中心低 0.57px
   *   字号 16 → 0.25   19.125 → 0.79   22 → 0.79   26 → 1.28
   * 即偏移 ≈ 0.044 × 字号。若不补偿，高亮与手柄会整体「偏高一点点」，
   * 小字因墨迹相对更大而更明显（用户反馈「小字高亮比字的中心高一些」）。
   * 补偿 = 把高亮块与手柄圆点整体下移这个量，使视觉上以墨迹为中心。
   * 注：系数按中文字体的平均度量取值；若更换字体后仍有偏差，重跑 diag-center2.js 标定。 */
  const INK_SHIFT_RATIO = 0.044;
  function inkCenterShift() {
    const fs = (Mirror.metrics && Mirror.metrics.fontSize) || 16;
    return fs * INK_SHIFT_RATIO;
  }

  function placeHandle(el, pos) {
    el.style.left = pos.x + 'px';
    /* ★ 圆点要对准「行的垂直中心」，不能按固定偏移。
     * CSS 里圆点中心在 handle 内部 y = 10 + 13/2 = 16.5px 处。
     * 以前写 pos.y - HANDLE_STEM(10) → 圆点落在行顶下方 6.5px，
     * 而行中心是 pos.y + h/2（h=行高，实测 35.4 时中心在 +17.7）→ 偏上 11px。
     * 现在按行高动态算，任何字号下都居中；再加墨迹修正量，与高亮块保持同一基准。 */
    const dotCenterInHandle = 16.5;
    const rowCenter = pos.y + (pos.h || 0) / 2 + inkCenterShift();
    el.style.top = (rowCenter - dotCenterInHandle) + 'px';
  }

  /* ---------------- 浮条 ---------------- */
  /* 浮条按钮。对标系统 ActionMode：剪切 / 复制 / 粘贴 / 全选。
   * 粘贴需要读取剪贴板：优先用 Android 壳的 native.getClipboard()（非 https 下文
   * navigator.clipboard 不可用，因为 http://192.168.x.x 不是安全上下文）。
   *
   * 关于「返回选区」：原设计是把它作为「选中文本 → AI 定向处理」的入口，
   * 但下游消费方（阶段 2）尚未实现，点下去只有提示、没有实际作用，
   * 属于「看得见但没用」的假按钮。经确认先隐藏，避免误导使用者。
   * 实现路径已保留：exposeSelection() / onAction('expose') / window.xietaiSel 接口
   * 与 xietai:selection 事件都还在，阶段 2 接上消费方后把下面一行取消注释即可恢复。
   */
  const SHOW_EXPOSE = false;   // ← 阶段 2 接入 AI 定向处理后改为 true

  function canPaste() {
    try { if (window.native && typeof window.native.getClipboard === 'function') return true; } catch (e) { }
    return !!(navigator.clipboard && navigator.clipboard.readText);
  }

  function buildActions() {
    const list = [
      { id: 'cut', label: '剪切' },
      { id: 'copy', label: '复制' }
    ];
    if (canPaste()) list.push({ id: 'paste', label: '粘贴' });
    list.push({ id: 'selectAll', label: '全选' });
    if (SHOW_EXPOSE) list.push({ id: 'expose', label: '返回选区' });
    return list;
  }

  function buildBar() {
    if (!bar) return;
    bar.innerHTML = buildActions().map(a =>
      '<button class="ss-btn" data-act="' + a.id + '">' + a.label + '</button>'
    ).join('');
    bar.onclick = e => {
      const b = e.target.closest('.ss-btn');
      if (!b) return;
      e.stopPropagation();
      onAction(b.dataset.act);
    };
  }

  function showBar(start, end) {
    if (!bar) return;
    if (!bar.children.length) buildBar();
    const rects = Mirror.rectsOf(start, end);
    if (!rects.length) { hideBar(); return; }
    const last = rects[rects.length - 1];
    const cs = getComputedStyle(ed);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padT = parseFloat(cs.paddingTop) || 0;

    bar.style.display = 'flex';
    // 先放到选区末尾下方；下方不够 → 放选区起头上方；都不够 → 贴可见区底部
    let top = last.y + padT - ed.scrollTop + last.h + 10;
    const barH = bar.offsetHeight || 46;
    if (top + barH > ed.clientHeight - 4) {
      const first = rects[0];
      const above = first.y + padT - ed.scrollTop - barH - 10;
      if (above >= 4) {
        top = above;
      } else {
        // 选区跨越整屏（起点和终点都在视口外）：贴在可见区底部，保证一定能看到且可点
        top = Math.max(4, ed.clientHeight - barH - 8);
      }
    }
    // 水平位置：优先对齐选区最后一行的左端，放不下就向右收
    let left = last.x + padL;
    const bw = bar.offsetWidth || 200;
    const edW = ed.clientWidth;
    if (left + bw > edW - 6) left = edW - bw - 6;
    if (left < 6) left = 6;

    /* ★ 竖直兜底：选区可能完全在可视区之外（例如先滚动再通过接口设选区、
     * 或拖选后惯性继续滑走），此时按行位置算出的 top 会跑到屏幕外，
     * 浮条变成点不到。统一夹在可视区内。 */
    const maxTop = ed.clientHeight - barH - 4;
    if (top > maxTop) top = maxTop;
    if (top < 4) top = 4;

    bar.style.top = Math.round(top) + 'px';
    bar.style.left = Math.round(left) + 'px';
  }

  function hideBar() { if (bar) bar.style.display = 'none'; }

  /* ---------------- 编辑与剪贴板 ---------------- */
  let selfEdit = false;   // 标记「改动由本模块发起」，避免 input 监听把自己的改动当成用户输入

  /** 用一段文本替换 [start,end)。会同步原生光标并通知应用层（更新正文+保存） */
  function applyEdit(start, end, text) {
    if (!ed) return;
    const v = ed.value;
    ed.value = v.slice(0, start) + text + v.slice(end);
    const caret = start + text.length;
    try { ed.setSelectionRange(caret, caret); } catch (e) { }
    selfEdit = true;
    try { ed.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) { }
    selfEdit = false;
    Mirror.cachedVal = null;
    S.anchor = -1; S.focus = -1;
    render();
    return caret;
  }

  /** 复制：用离屏 textarea，绝不碰编辑器自身的原生选区，避免闪一下系统选区 */
  function copyToClipboard(text) {
    return new Promise(resolve => {
      let ok = false;
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, text.length);
        ok = document.execCommand('copy');
        ta.remove();
      } catch (e) { ok = false; }
      if (ok) return resolve(true);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => resolve(true), () => resolve(false));
      } else resolve(false);
    });
  }

  /** 读剪贴板：优先原生桥（http 非安全上下文可用），其次 clipboard API */
  async function readClipboard() {
    try {
      if (window.native && typeof window.native.getClipboard === 'function') {
        const t = window.native.getClipboard();
        if (typeof t === 'string') return t;
      }
    } catch (e) { }
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        return await navigator.clipboard.readText();
      }
    } catch (e) { }
    return null;
  }

  function selRange() {
    if (S.anchor < 0) return null;
    const f = S.focus >= 0 ? S.focus : S.anchor;
    return { start: Math.min(S.anchor, f), end: Math.max(S.anchor, f) };
  }

  async function onAction(id) {
    const rg = selRange();
    const hasRange = rg && rg.end > rg.start;
    const text = hasRange ? ed.value.slice(rg.start, rg.end) : '';

    if (id === 'copy') {
      if (!hasRange) { toast('未选中内容'); return; }
      const ok = await copyToClipboard(text);
      toast(ok ? ('已复制 ' + text.length + ' 字') : '复制失败');
      return;
    }

    if (id === 'cut') {
      if (!hasRange) { toast('未选中内容'); return; }
      const ok = await copyToClipboard(text);
      if (!ok) { toast('剪切失败：无法写入剪贴板'); return; }
      applyEdit(rg.start, rg.end, '');
      toast('已剪切 ' + text.length + ' 字');
      return;
    }

    if (id === 'paste') {
      const t = await readClipboard();
      if (t === null) { toast('无法读取剪贴板'); return; }
      if (!t) { toast('剪贴板为空'); return; }
      // 有选区则替换，无选区则插入到光标处
      const at = hasRange ? rg.start : (S.focus >= 0 ? S.focus : (S.anchor >= 0 ? S.anchor : 0));
      const end = hasRange ? rg.end : at;
      applyEdit(at, end, t);
      toast('已粘贴 ' + t.length + ' 字');
      return;
    }

    if (id === 'selectAll') {
      /* 全选的两个约束，必须同时满足：
       *   1) 要让输入法有输入目标 → 必须 focus 并放置原生光标；
       *   2) 视图不能跳走 → 光标绝不能放在文末。
       * 早期把光标设在 value.length（文末），WebView 认为「光标在结尾」，
       * 于是自动滚到底部（实测 scrollTop 528 → 7929），用户眼前突然变成文章结尾。
       * 做法：把光标放到「当前视口顶部附近对应的字符」，视图原地不动；
       * 真正的替换/删除区间由 beforeinput 桥临时切成 [0, len]。 */
      const keepTop = ed.scrollTop;
      S.anchor = 0;
      S.focus = ed.value.length;

      Mirror.refreshIfNeeded();
      const cs = getComputedStyle(ed);
      const padT = parseFloat(cs.paddingTop) || 0;
      let caret = Mirror.charAtY(Math.max(0, keepTop - padT));
      caret = Math.max(0, Math.min(caret, ed.value.length));

      nativeSetting = true;
      try { ed.setSelectionRange(caret, caret); } catch (e) { }
      nativeSetting = false;
      nativeMark = { a: caret, b: caret, t: Date.now() };

      try { if (document.activeElement !== ed) ed.focus({ preventScroll: true }); } catch (e) { }
      ed.scrollTop = keepTop;
      render();
      requestAnimationFrame(() => { ed.scrollTop = keepTop; render(); });
      toast('已全选 ' + ed.value.length + ' 字');
      return;
    }

    if (id === 'expose') {
      if (!hasRange) { toast('未选中内容'); return; }
      exposeSelection({ start: rg.start, end: rg.end, text });
      toast('已获取选区 ' + text.length + ' 字');
      return;
    }
  }

  function toast(msg) {
    if (typeof window.v2Toast === 'function') { try { window.v2Toast(msg, 'ok'); return; } catch (e) { } }
  }

  /* ---------------- 对外接口 ---------------- */
  function exposeSelection(sel) {
    S.selText = sel.text;
    try {
      window.dispatchEvent(new CustomEvent('xietai:selection', { detail: sel }));
    } catch (e) { }
    if (typeof window.onSelectionAction === 'function') {
      try { window.onSelectionAction(sel); } catch (e) { }
    }
  }

  /* ---------------- 手势 ---------------- */
  function isEditableFocus() {
    if (!ed) return false;
    const a = document.activeElement;
    return a === ed;
  }

  /** 这是否是一次我们该接管的触摸 */
  function shouldTake(e) {
    if (!ed || !ed.offsetParent) return false;
    if (e.touches && e.touches.length > 1) return false;   // 多指放行（缩放）
    /* ★ 只接管「落在 textarea 本身」的触摸。
     * 以前只排除 .ss-bar，结果压在编辑器上的其它控件也被 preventDefault 吞掉：
     * 左右抽屉的折叠竖条(.v2-collapsed-tab / .pool-tab，z-index 46)就在左/右边缘
     * 22px 内、正好落在编辑器矩形里 → 实测「左右栏呼不出来」。
     * 用 target === ed 一次解决：浮条、竖条、以及任何后续新增的覆盖控件都不会被误吞
     * （浮条与高亮层都是 pointer-events:none 或独立节点，target 不会变成它们）。 */
    if (e.target !== ed) return false;
    const t = e.touches[0];
    if (!t) return false;
    const r = ed.getBoundingClientRect();
    return t.clientX >= r.left && t.clientX <= r.right
        && t.clientY >= r.top && t.clientY <= r.bottom;
  }

  /* ★ 同步原生选区（关键修复）
   * 自绘选区原本完全独立于 textarea 的 selectionStart/End，导致：
   *  1) 原生光标停在旧位置（常见是全文末尾），长按后 focus() 会让 Android
   *     把视图滚动到那个位置 → 表现为「忘掉之前的选区、从末端继续」；
   *  2) 打字/输入法候选上屏会插到那个旧位置，而不是用户看到的光标处。
   * 这里始终把原生选区收成「焦点端的折叠光标」：既能显示正确的原生光标外观，
   * 又不会因为是非折叠区间而触发系统选区手柄与 ActionMode。 */
  /* ★ 同步原生选区
   * 这里有一个必须两头兼顾的矛盾：
   *   A. 原生选区若是「折叠光标」→ 系统不画自己的 selection handle，视觉干净；
   *      但 Chromium 只看到一个光标点，打字不会替换选区、退格只删一个字。
   *   B. 原生选区若是「真实区间」→ 打字/退格/粘贴天然正确；
   *      但 Android 会在两端绘制系统自带的蓝色 handle（实测起点 475px、终点 758px
   *      的 (64,96,160) 像素），与我们紫色自绘手柄重叠成双份，很难看。
   *
   * 解法：平时保持折叠光标（视觉干净），**只在输入动作发生前的一瞬间**切换成真实区间
   * （见 bindNativeEditBridge 里的 beforeinput），让浏览器按真实区间执行替换/删除，
   * 输入完成后再退回折叠。这样两者兼得。
   */
  let nativeSetting = false;   // 标记「正在由本模块写原生选区」，避免被自身的 change 监听当成用户操作
  /* ★ selectionchange 是异步派发的，等它到达时 nativeSetting 早已复位，
   * 所以不能只靠那个同步标志。这里额外记录「我们最近一次写入的值 + 时间」，
   * 让 selectionchange 能识别出「这次变化是我自己造成的」。 */
  let nativeMark = null;

  function syncNative(keepScroll) {
    if (!ed) return;
    const idx = (S.focus >= 0) ? S.focus : S.anchor;
    if (idx < 0) return;
    const st = ed.scrollTop;
    nativeSetting = true;
    try { ed.setSelectionRange(idx, idx); } catch (e) { }
    nativeSetting = false;
    nativeMark = { a: idx, b: idx, t: Date.now() };
    if (keepScroll !== false && ed.scrollTop !== st) ed.scrollTop = st;
  }

  /* ★ 输入桥：把「自绘选区」翻译成一次原生的区间编辑
   * 在 beforeinput（输入动作提交前）把原生选区临时改成真实区间，
   * 浏览器随后执行默认动作时就会替换/删除整段。不 preventDefault，
   * 所以输入法组词、候选上屏、表情插入等都由 Chromium 原生处理，中文不会被破坏。 */
  function bindNativeEditBridge() {
    const RANGE_INPUTS = {
      insertText: 1, insertCompositionText: 1, insertFromPaste: 1, insertFromDrop: 1,
      deleteContentBackward: 1, deleteContentForward: 1,
      deleteByCut: 1, deleteWordBackward: 1, deleteWordForward: 1,
      deleteSoftLineBackward: 1, deleteSoftLineForward: 1
    };
    ed.addEventListener('beforeinput', (e) => {
      const active = S.anchor >= 0 && S.focus >= 0 && S.anchor !== S.focus;
      if (!active) return;
      if (!RANGE_INPUTS[e.inputType]) return;         // 选择类/格式类操作不在此处理
      const a = Math.min(S.anchor, S.focus);
      const b = Math.max(S.anchor, S.focus);
      if (ed.selectionStart === a && ed.selectionEnd === b) return;   // 已经是区间了
      nativeSetting = true;
      try { ed.setSelectionRange(a, b); } catch (er) { }
      nativeSetting = false;
      /* 不阻止默认：浏览器紧接着会按这个区间执行插入/删除 */
    }, true);
  }

  function onTouchStart(e) {
    if (!shouldTake(e)) return;
    const t = e.touches[0];
    const x = t.clientX, y = t.clientY;

    // ★ 接管的前提：必须在此同步阻止默认，否则会弹系统选择器
    e.preventDefault();

    stopAutoScroll();
    stopInertia();
    S.longPressed = false;
    if (S.press && S.press.timer) { clearTimeout(S.press.timer); S.press.timer = 0; }

    /* ★ 在这里就把滚动基准设好（而不是等第一次 touchmove 才发现没有基准）。
     * 否则第一个 move 只用来初始化、不产生位移 → 起步一帧丢位移 → 感觉不跟手。 */
    dragScrollLastY = y;
    dragLastT = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

    // 1) 命中当前可见的手柄？→ 拖端点（仅在已有选区时成立）
    const hasRange = S.anchor >= 0 && S.focus >= 0 && S.anchor !== S.focus;
    const hit = hasRange ? hitHandle(x, y) : null;
    if (hit) {
      S.dragging = hit;
      S.press = { x, y, t: Date.now(), timer: 0, moved: 0 };
      hideBar();
      return;
    }

    /* 2) 未命中手柄。★ 这里刻意不清空选区。
     * 用户反馈「选区手柄在屏幕下方，需要滑动才能看到，一滑动选区就没了」——
     * 因为以前在 touchstart 就无条件清空，把「滚动去找手柄」也算成了放弃选区。
     * 现在改成「清空动作跟着手势结果走」：
     *   · 判定为滚动 → 完全不动选区（手柄可能只是暂时滚出可视区）
     *   · 判定为 tap  → 由 tap 分支重新落光标（新 anchor/focus 天然替换旧的）
     *   · 判定为长按 → 由长按分支重新落光标
     * 因此不需要额外的 clearPending 标记，状态更少、更不易出错。 */

    // 3) 记下按下信息，启动长按定时器
    S.press = {
      x, y, t: Date.now(), moved: 0,
      timer: setTimeout(() => {
        if (!S.press) return;
        // 长按：落光标 + 放出起点手柄（不猜用户要选什么）
        const idx = Mirror.caretAt(S.press.x, S.press.y);
        S.anchor = idx; S.focus = idx;
        /* ★ 不立刻置 dragging='end'。
         * 若立刻置上，手指抬起前的任何微小 MOVE 都会改变 focus，凭空产生一段选区
         * （实测长按静止不动也会得到 116~201 这种意外选区）。
         * 改为标记 longPressed，等位移真正超过阈值才进入扩展模式。 */
        S.longPressed = true;
        /* ★ 顺序关键：先把原生光标放到 idx，再 focus。
         * 反过来的话 Android 会先滚到旧光标位置（常常是全文末尾），
         * 用户看到的就是「视图跳到末端」。 */
        syncNative();
        render();
        if (navigator.vibrate) { try { navigator.vibrate(12); } catch (er) { } }
        try { if (document.activeElement !== ed) ed.focus({ preventScroll: true }); } catch (er) { }
      }, CFG.LONG_PRESS_MS)
    };
  }

  function onTouchMove(e) {
    if (!S.press && !S.dragging) {
      // 没有任何状态但落在编辑器上 → 交给滚动逻辑
      if (shouldTake(e)) { e.preventDefault(); doScrollDrag(e); }
      return;
    }
      const t = e.touches[0];
    if (!t) return;
    e.preventDefault();
    const x = t.clientX, y = t.clientY;
    S.lastX = x; S.lastY = y;      // 自动滚动时用「手指位置」反推字符
    const dx = x - S.press.x, dy = y - S.press.y;
    S.press.moved = Math.max(S.press.moved, Math.abs(dx) + Math.abs(dy));

    if (S.dragging === 'start' || S.dragging === 'end') {
      Mirror.refreshIfNeeded();
      const idx = Mirror.caretAt(x, y);
      if (S.dragging === 'start') S.anchor = idx; else S.focus = idx;
      render();
      maybeAutoScroll(y);
      return;
    }

    // 长按已触发但还没开始拖：位移超过阈值才进入扩展（避免手抖产生意外选区）
    if (S.longPressed && S.press.moved > 12) {
      S.dragging = 'end';
      Mirror.refreshIfNeeded();
      const idx = Mirror.caretAt(x, y);
      S.focus = idx;
      render();
      maybeAutoScroll(y);
      return;
    }

    // 还没进入拖动：判断是想滚动还是想选择
    if (S.press.moved > CFG.TAP_MAX_MOVE) {
      // 位移明显 → 取消长按，改为滚动
      if (S.press.timer) { clearTimeout(S.press.timer); S.press.timer = 0; }
      if (!S.longPressed) doScrollDrag(e);   // 已长按过则不改滚动，避免误滚
    }
  }

  function onTouchEnd(e) {
    const now = Date.now();
    if (S.press && S.press.timer) { clearTimeout(S.press.timer); S.press.timer = 0; }
    stopAutoScroll();

    const wasDragging = S.dragging;
    const wasLong = S.longPressed;
    const press = S.press;
    S.press = null;
    S.dragging = null;
    S.longPressed = false;

    if (wasDragging) {
      // 拖动结束：把手柄端点的位置同步给原生选区，随后再显示浮条
      syncNative();
      /* 必须有焦点，否则打字不会替换选区（输入法没有输入目标） */
      try { if (document.activeElement !== ed) ed.focus({ preventScroll: true }); } catch (e) { }
      if (S.anchor >= 0 && S.focus >= 0 && S.anchor !== S.focus) {
        render();
      } else if (S.anchor >= 0) {
        render();
      }
      /* ★ 拖选结束不启动惯性。
       * 用户抬手的意图是「选区就定在这里」，此时若沿用拖动带来的速度继续滚动，
       * 视图会自己滑走、手柄跑出屏幕，看起来像选区错位。
       * 顺便把速度清零，避免下一次滚动误用旧值。 */
      stopInertia();
      return;
    }

    // 长按后没拖动就抬手：保留光标与起点手柄，不当作 tap 重新定位
    if (wasLong) {
      render();
      return;
    }

    if (!press) return;
    const dur = now - press.t;

    // tap：定位光标
    if (press.moved <= CFG.TAP_MAX_MOVE && dur <= CFG.TAP_MAX_MS) {
      // 双击 → 选整段（用户要求不做分词，双击给「整句/整段」）
      const isDouble = (now - S.lastTapAt < 300)
        && Math.abs(press.x - S.lastTapPos.x) < 40
        && Math.abs(press.y - S.lastTapPos.y) < 40;
      S.lastTapAt = now; S.lastTapPos = { x: press.x, y: press.y };

      Mirror.refreshIfNeeded();
      const idx = Mirror.caretAt(press.x, press.y);
      if (isDouble) {
        const rg = sentenceRangeAt(idx);
        S.anchor = rg.start; S.focus = rg.end;
        /* 双击选句也同步真实区间：与原生习惯一致，双击后可直接打字替换整句 */
        syncNative();
        try { if (document.activeElement !== ed) ed.focus({ preventScroll: true }); } catch (er) { }
      } else {
        S.anchor = idx; S.focus = idx;
        /* ★ 先把原生光标放到 idx 再 focus：避免 Android 滚到旧光标位置 */
        syncNative();
        try { if (document.activeElement !== ed) ed.focus({ preventScroll: true }); } catch (er) { }
      }
      render();
      // tap 没有产生滚动速度，不能触发惯性（否则会把旧速度误当成本次挥手）
      stopInertia();
      return;
    }

    // 一次普通的滑动手势（滚动）→ 只做惯性
    // ★ 滚动不再清空选区：用户可能是为了把手柄滚进可视区才滑动的。
    startInertia(now);
  }

  /* ---------------- 手柄命中 ---------------- */
  function hitHandle(x, y) {
    const test = (el, kind) => {
      if (!el || el.style.display === 'none') return false;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      return Math.hypot(x - cx, y - cy) <= CFG.HANDLE_HIT;
    };
    if (test(hEnd, 'end')) return 'end';
    if (test(hStart, 'start')) return 'start';
    return null;
  }

  /* ---------------- 滚动：跟手拖动 + 惯性抛掷 ----------------
   * 早期实现只把「最后一次 move 的位移」当速度，且没记时间戳，
   * 所以快速滑动时抬手速度几乎为 0 → 没有惯性；慢速滑动反而可能残留很大值 → 乱滑。
   * 现在改为按「最近若干次采样」算速度（px/ms），这是惯性是否自然的关键。 */
  let dragScrollLastY = 0;
  let dragLastT = 0;
  let vel = 0;                  // px/ms（正=内容向上走）
  const VEL_SAMPLES = [];       // 最近采样 [{dy, dt}]

  function pushSample(dy, dt) {
    if (dt <= 0) return;
    VEL_SAMPLES.push({ dy, dt });
    if (VEL_SAMPLES.length > 5) VEL_SAMPLES.shift();
  }
  function computeVelocity() {
    if (!VEL_SAMPLES.length) return 0;
    let dy = 0, dt = 0;
    for (const s of VEL_SAMPLES) { dy += s.dy; dt += s.dt; }
    if (dt <= 0) return 0;
    const v = dy / dt;                        // px/ms，正=手指往上推=内容上移
    // 把「内容位移速度」换算成「scrollTop 增速」（与本模块 dy = lastY - y 同向）
    return v;
  }

  function doScrollDrag(e) {
    const t = e.touches[0];
    if (!t) return;
    S.dbgScroll = (S.dbgScroll || 0) + 1;
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    /* ★ 起点已在 touchstart 里初始化，这里不再有「首次 move 只记录不位移」的分支。
     * 那个分支会让滑动的第一帧位移被吞掉（手指已经动了但内容没动），
     * 手感上就是「快速滑动不跟手、起步发涩」。 */
    if (!dragScrollLastY) { dragScrollLastY = t.clientY; dragLastT = now; return; }
    const dy = dragScrollLastY - t.clientY;
    const dt = now - dragLastT;
    dragScrollLastY = t.clientY;
    dragLastT = now;
    S.dbgDy = dy;
    if (dy) {
      const b0 = ed.scrollTop;
      ed.scrollTop += dy;
      S.dbgApplied = ed.scrollTop - b0;
      pushSample(dy, dt);
      vel = computeVelocity();
      /* ★ 只有存在选区时才需要重绘高亮；纯滚动时零渲染开销。
       * 以前无条件 requestRender，每帧都要跑 render()（含两次 getBoundingClientRect
       * 强制同步布局 + 清空重建高亮节点），这是快速滑动掉帧、不跟手的主因。 */
      if (S.anchor >= 0) requestRender();
    }
  }

  const CFG_EXTRA = {
    FLING_MIN: 0.18,      // px/ms，低于此不抛掷（防止轻微一划就飞出去）
    FLING_MAX: 3.2,       // 上限，避免一次猛划滚太远
    DECAY: 0.955          // 每帧速度衰减
  };

  function startInertia() {
    dragScrollLastY = 0;
    dragLastT = 0;
    const v = vel || computeVelocity();
    S.dbgFling = v;
    VEL_SAMPLES.length = 0;
    vel = 0;
    if (!isFinite(v) || Math.abs(v) < CFG_EXTRA.FLING_MIN) return;

    stopInertia();
    let speed = Math.max(-CFG_EXTRA.FLING_MAX, Math.min(CFG_EXTRA.FLING_MAX, v));
    // 固定 60fps 步长估算：v(px/ms) * 16.7 ≈ 每帧位移
    let perFrame = speed * 16.7;
    let last = 0;
    const step = ts => {
      /* ★ 第一帧只用来对齐时间基准，不做位移。
       * 早期写法是 `if(!last) last = ts;` 紧接着算 dtF = ts-last = 0，
       * 于是位移为 0 → 命中下面的「scrollTop 没变 = 到边界」判断 → 循环立刻退出，
       * 表现就是「完全没有惯性」。必须先返回，下一帧再真正开始。 */
      if (!last) { last = ts; S.rafScroll = requestAnimationFrame(step); return; }
      const dtF = Math.min(48, ts - last) / 16.7;   // 自适应帧时长，掉帧时补偿
      last = ts;
      perFrame *= Math.pow(CFG_EXTRA.DECAY, dtF);
      if (Math.abs(perFrame) < 0.5) { S.rafScroll = 0; return; }
      const before = ed.scrollTop;
      ed.scrollTop += perFrame * dtF;
      if (ed.scrollTop === before) { S.rafScroll = 0; return; }   // 到边界
      requestRender();
      S.rafScroll = requestAnimationFrame(step);
    };
    S.rafScroll = requestAnimationFrame(step);
  }

  function stopInertia() {
    if (S.rafScroll) { cancelAnimationFrame(S.rafScroll); S.rafScroll = 0; }
    VEL_SAMPLES.length = 0;
    vel = 0;
    dragScrollLastY = 0;
    dragLastT = 0;
  }

  /* ---------------- 合帧渲染 ----------------
   * 滚动/拖动会以 60~120Hz 触发，若每次都同步 render()（内含 Range.getClientRects
   * 与 DOM 重建）就会掉帧。统一走 requestRender()，一帧最多画一次。 */
  let renderRaf = 0;
  function requestRender() {
    if (renderRaf) return;
    renderRaf = requestAnimationFrame(() => {
      renderRaf = 0;
      render();
    });
  }

  /* ---------------- 自动滚动（拖选到边缘时） ---------------- */
  function maybeAutoScroll(clientY) {
    const r = ed.getBoundingClientRect();
    let dir = 0, amt = 0;
    if (clientY > r.bottom - CFG.EDGE_ZONE) {
      dir = 1;
      amt = (clientY - (r.bottom - CFG.EDGE_ZONE)) / CFG.EDGE_ZONE;
    } else if (clientY < r.top + CFG.EDGE_ZONE) {
      dir = -1;
      amt = ((r.top + CFG.EDGE_ZONE) - clientY) / CFG.EDGE_ZONE;
    }
    if (!dir) { stopAutoScroll(); return; }
    S.autoDir = dir;
    S.autoSpeed = CFG.SCROLL_MIN + (CFG.SCROLL_MAX - CFG.SCROLL_MIN) * Math.min(1, amt);
    if (!S.autoTimer) S.autoTimer = requestAnimationFrame(autoScrollStep);
  }

  function autoScrollStep() {
    S.autoTimer = 0;
    if (!S.autoDir || !S.dragging) return;
    const before = ed.scrollTop;
    ed.scrollTop += S.autoDir * S.autoSpeed;
    if (ed.scrollTop === before) {
      // 已到内容边界：停止
      S.autoDir = 0;
      return;
    }
    // 滚动后需要更新焦点端字符：用「手指当前屏幕位置」反推。
    // ★ 不能用「手柄屏幕位置」—— 手柄位置本就由字符算出，反推会形成循环依赖，焦点永远不动。
    Mirror.refreshIfNeeded();
    if (typeof S.lastX === 'number' && typeof S.lastY === 'number') {
      const idx = Mirror.caretAt(S.lastX, S.lastY);
      if (S.dragging === 'start') S.anchor = idx; else S.focus = idx;
    }
    render();
    S.autoTimer = requestAnimationFrame(autoScrollStep);
  }

  function stopAutoScroll() {
    S.autoDir = 0;
    if (S.autoTimer) { cancelAnimationFrame(S.autoTimer); S.autoTimer = 0; }
  }

  /* ---------------- 双击选段（不做分词，退回按标点断句） ---------------- */
  function sentenceRangeAt(idx) {
    const v = ed.value;
    const isBound = ch => '。！？!?；;\n\r'.indexOf(ch) >= 0;
    let s = idx, e = idx;
    while (s > 0 && !isBound(v[s - 1])) s--;
    while (e < v.length && !isBound(v[e])) e++;
    if (e < v.length) e++;    // 含住标点
    if (s === e) { s = Math.max(0, idx - 1); e = Math.min(v.length, idx + 1); }
    return { start: s, end: e };
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    if (!ENABLED) return;
    ed = document.getElementById('editor');
    if (!ed) return;

    // 只在触摸设备启用；桌面鼠标保持原生行为
    const coarse = window.matchMedia && window.matchMedia('(pointer:coarse)').matches;
    if (!coarse) return;

    ensureDom();
    buildBar();
    hideBar();

    document.addEventListener('touchstart', onTouchStart, { passive: false, capture: true });
    document.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
    document.addEventListener('touchend', onTouchEnd, { passive: true, capture: true });
    document.addEventListener('touchcancel', onTouchEnd, { passive: true, capture: true });

    // 内容或尺寸变化 → 重建镜像
    /* ★ 只有「文本真的变了」才放弃选区。
     * Android 在输入法连接建立/候选框出现时会派发一次 input 事件（inputType 为
     * 空的组合更新），文本其实没变。早期版本一收到 input 就清选区，
     * 于是「呼出输入法后选区消失 / 重新选择像是从末端继续」。
     * 用 lastVal 比对，既忽略这类空事件，又能在真正打字后清掉残留高亮。 */
    let lastVal = ed.value;
    ed.addEventListener('input', () => {
      const changed = (ed.value !== lastVal);
      lastVal = ed.value;
      Mirror.cachedVal = null;
      if (!changed) return;             // 空组合 / 无实质改动 → 不动选区
      if (selfEdit) return;             // 本模块发起的改动，选区已单独处理
      if (S.anchor >= 0) { S.anchor = -1; S.focus = -1; render(); }
    }, { passive: true });

    /* ★ 光标被外部移动 → 放弃自绘选区，回到普通编辑
     * 覆盖这些入口：点击定位、键盘方向键、输入法候选上屏后移动光标、粘贴后跳转。
     * 判定方式：原生选区与本模块记录的选区不一致，且不是我们自己在写（nativeSetting）、
     * 也不在拖选过程中，就认为用户「用光标重新定位了」，清掉高亮与手柄。
     * 这就是用户要的「光标左右移动能重置选择、恢复正常编辑」。 */
    document.addEventListener('selectionchange', () => {
      if (!ed || nativeSetting || S.dragging) return;
      if (S.anchor < 0 && S.focus < 0) return;         // 本来就没有自绘选区
      const a = ed.selectionStart, b = ed.selectionEnd;
      /* 是我刚写入的那个折叠光标 → 忽略（否则拖选一结束就会被自己清掉） */
      if (nativeMark && a === nativeMark.a && b === nativeMark.b && (Date.now() - nativeMark.t) < 800) return;
      const myA = Math.min(S.anchor, S.focus >= 0 ? S.focus : S.anchor);
      const myB = Math.max(S.anchor, S.focus >= 0 ? S.focus : S.anchor);
      if (a === myA && b === myB) return;              // 一致 → 是我们期望的状态
      S.anchor = -1; S.focus = -1;
      nativeMark = null;
      hideBar();
      render();
    }, { passive: true });
    /* 滚动时重绘高亮：只走合帧渲染。
     * 不再在这里直接调 syncLayerBox() —— 那会每次滚动都做两次 getBoundingClientRect
     * 强制同步布局，是掉帧的隐形来源。render() 内部本身会 syncLayerBox()。 */
    ed.addEventListener('scroll', () => { if (S.anchor >= 0) requestRender(); }, { passive: true });
    window.addEventListener('resize', () => { Mirror.cachedVal = null; Mirror.build(); syncLayerBox(); if (S.anchor >= 0) render(); });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', () => { syncLayerBox(); if (S.anchor >= 0) render(); });
    }

    // 让打字 / 退格 / 粘贴按「自绘选区」执行（临时把原生选区切成真实区间）
    bindNativeEditBridge();

    S.inited = true;

    /* 对外接口：返回选中的词，供后续定向处理扩展 */
    window.xietaiSel = {
      get text() { return (S.anchor >= 0 && S.anchor !== S.focus) ? ed.value.slice(Math.min(S.anchor, S.focus), Math.max(S.anchor, S.focus)) : ''; },
      get range() { return (S.anchor >= 0 && S.anchor !== S.focus) ? { start: Math.min(S.anchor, S.focus), end: Math.max(S.anchor, S.focus) } : null; },
      set(a, b) {
        /* 夹到合法范围：越界索引会让镜像取不到矩形，手柄/高亮失效 */
        const n = ed.value.length;
        const cl = v => Math.max(0, Math.min(Number(v) || 0, n));
        S.anchor = cl(a); S.focus = cl(b); render();
      },
      clear() { S.anchor = S.focus = -1; S.dragging = null; render(); },
      rerender() { Mirror.cachedVal = null; render(); },
      /** 调试/外部定位用：字符偏移 → 内容坐标 y（相对镜像内容区原点） */
      _charY(idx) { Mirror.refreshIfNeeded(); return Mirror.charY(idx); },
      /** 调试/外部定位用：把某个字符滚到视口中部 */
      _scrollTo(idx) {
        Mirror.refreshIfNeeded();
        const y = Mirror.charY(idx);
        const cs = getComputedStyle(ed);
        const padT = parseFloat(cs.paddingTop) || 0;
        ed.scrollTop = Math.max(0, (y - padT) - ed.clientHeight / 2);
        return Math.round(ed.scrollTop);
      },
      /** 调试用：镜像层几何与采样 */
      _mirror() {
        Mirror.refreshIfNeeded();
        if (!Mirror.box) return { err: 'no mirror' };
        const b = Mirror.box.getBoundingClientRect();
        const i = Mirror.inner.getBoundingClientRect();
        const tn = Mirror.inner.firstChild;
        const total = tn ? tn.nodeValue.length : 0;
        const sample = [0, 1, 5, 21, 22, 60, 200].map(k => {
          const rs = Mirror.rectsOf(k, Math.min(k + 1, total));
          return { k, r: rs[0] ? { x: Math.round(rs[0].x), y: Math.round(rs[0].y), w: Math.round(rs[0].w), h: Math.round(rs[0].h) } : null };
        });
        return {
          box: { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) },
          inner: { x: Math.round(i.left), y: Math.round(i.top), w: Math.round(i.width), h: Math.round(i.height) },
          metrics: Mirror.metrics, total, sample,
          head: (Mirror.inner.textContent || '').slice(0, 24)
        };
      },
      /** 调试用：当前内部状态快照 */
      _state() {
        return {
          anchor: S.anchor, focus: S.focus, dragging: S.dragging,
          longPressed: !!S.longPressed, inited: S.inited,
          hasPress: !!S.press, hasTimer: !!(S.press && S.press.timer),
          dbgScroll: S.dbgScroll || 0, dbgDy: S.dbgDy, dbgApplied: S.dbgApplied,
          dbgFling: S.dbgFling, rafScroll: S.rafScroll || 0
        };
      },
      /* 调试用：把 client 坐标换算成字符偏移，并给出中间量 */
      _probe(x, y) {
        Mirror.refreshIfNeeded();
        if (!Mirror.inner) return { err: 'no mirror', hasEd: !!ed, hasBox: !!Mirror.box };
        const edRect = ed.getBoundingClientRect();
        const cs = getComputedStyle(ed);
        const padT = parseFloat(cs.paddingTop) || 0;
        const padL = parseFloat(cs.paddingLeft) || 0;
        const base = Mirror.inner.getBoundingClientRect();
        return {
          relY: y - edRect.top - padT + ed.scrollTop,
          relX: x - edRect.left - padL,
          baseTop: base.top, baseLeft: base.left,
          edTop: edRect.top, padT, scrollTop: ed.scrollTop,
          lineH: Mirror.metrics ? Mirror.metrics.lineH : null,
          caret: Mirror.caretAt(x, y),
          textAt: ed.value.slice(Math.max(0, Mirror.caretAt(x, y) - 12), Mirror.caretAt(x, y) + 12)
        };
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
