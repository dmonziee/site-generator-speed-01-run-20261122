// solve.js — a fast, dependency-free reimplementation of makefun-site 1.0.0,
// written from its README spec. run(input) returns the output tree:
// a JSON object of every output path and that file's text, byte for byte.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// ---------- text ----------
const ESCMAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// Fast path: most strings have no HTML special at all — one native test
// returns them untouched. Only strings holding a special pay for replace.
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;
function esc(s) {
  if (!ESC_TEST.test(s)) return s;
  return s.replace(ESC_RE, c => ESCMAP[c]);
}

function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function slugOf(text) {
  const cached = SLUG_CACHE.get(text);
  if (cached !== undefined) return cached;
  const result = slugOfCompute(text);
  SLUG_CACHE.set(text, result);
  return result;
}
const SLUG_CACHE = new Map();
function slugOfCompute(text) {
  const norm = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let lastDash = true; // suppress a leading dash
  for (let i = 0; i < norm.length; i++) {
    let code = norm.charCodeAt(i);
    if (code >= 65 && code <= 90) code += 32; // A-Z -> a-z
    if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) {
      out += String.fromCharCode(code);
      lastDash = false;
    } else if (!lastDash) {
      out += '-';
      lastDash = true;
    }
  }
  if (out.length > 0 && out.charCodeAt(out.length - 1) === 45) out = out.slice(0, -1);
  if (out.length > 64) {
    out = out.slice(0, 64);
    if (out.charCodeAt(out.length - 1) === 45) out = out.slice(0, -1);
  }
  return out === '' ? 'untitled' : out;
}

function dateLong(ds) {
  // ds is YYYY-MM-DD; day without a leading zero, full month name, year.
  const y = ds.slice(0, 4);
  const m = (ds.charCodeAt(5) - 48) * 10 + (ds.charCodeAt(6) - 48);
  let d = ds.charCodeAt(8) - 48;
  d = d * 10 + (ds.charCodeAt(9) - 48);
  return d + ' ' + MONTHS[m - 1] + ' ' + y;
}

// ---------- templates ----------
function parsePath(str) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(str)) return null;
  return str.split('.');
}

// Node kinds: 0 text, 1 var, 2 for, 3 if, 4 include.
function parseTemplate(src) {
  // Tokenize, honouring the rule that a {% %} tag alone on its line
  // takes the whole line with it, its \n included.
  const toks = [];
  const n = src.length;
  let i = 0;
  let textStart = 0;
  function pushText(a, b) { if (b > a) toks.push({ t: 0, s: src.slice(a, b) }); }
  while (i < n) {
    const open2 = src.indexOf('{{', i);
    const openTag = src.indexOf('{%', i);
    let j = -1, kind = 0;
    if (open2 !== -1 && (openTag === -1 || open2 < openTag)) { j = open2; kind = 1; }
    else if (openTag !== -1) { j = openTag; kind = 2; }
    else break;
    if (kind === 1) {
      const triple = src.charCodeAt(j + 2) === 123;
      const closeStr = triple ? '}}}' : '}}';
      const e = src.indexOf(closeStr, j + (triple ? 3 : 2));
      if (e === -1) return { ok: false, reason: triple ? 'a {{{ is not closed' : 'a {{ is not closed' };
      const inner = src.slice(j + (triple ? 3 : 2), e).trim();
      const path = parsePath(inner);
      if (!path) return { ok: false, reason: JSON.stringify(inner) + ' is not a path' };
      pushText(textStart, j);
      toks.push({ t: 1, path, raw: triple });
      i = e + closeStr.length;
      textStart = i;
    } else {
      const e = src.indexOf('%}', j + 2);
      if (e === -1) return { ok: false, reason: 'a {% is not closed' };
      const after = e + 2;
      // alone on its line?
      const ls = src.lastIndexOf('\n', j - 1);
      const lineStart = ls + 1;
      let alone = true;
      for (let k = lineStart; k < j; k++) {
        const c = src.charCodeAt(k);
        if (c !== 32 && c !== 9) { alone = false; break; }
      }
      if (alone) {
        let k = after;
        while (k < n) {
          const c = src.charCodeAt(k);
          if (c !== 32 && c !== 9) break;
          k++;
        }
        if (k < n && src.charCodeAt(k) === 10) alone = true;
        else if (k >= n) alone = true;
        else alone = false;
      }
      const inner = src.slice(j + 2, e).trim();
      // parse the tag
      let tag = null;
      if (inner === 'else') tag = { t: 'else' };
      else if (inner === 'endif') tag = { t: 'endif' };
      else if (inner === 'endfor') tag = { t: 'endfor' };
      else if (inner.startsWith('for ')) {
        const m = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/.exec(inner);
        if (!m) return { ok: false, reason: '{% ' + inner + ' %} is not a tag' };
        const path = parsePath(m[2]);
        if (!path) return { ok: false, reason: JSON.stringify(m[2]) + ' is not a path' };
        tag = { t: 'for', v: m[1], path };
      } else if (inner.startsWith('if ')) {
        const m = /^if (not )?(\S+)$/.exec(inner);
        if (!m) return { ok: false, reason: '{% ' + inner + ' %} is not a tag' };
        const path = parsePath(m[2]);
        if (!path) return { ok: false, reason: JSON.stringify(m[2]) + ' is not a path' };
        tag = { t: 'if', path, neg: !!m[1] };
      } else if (inner.startsWith('include ')) {
        const m = /^include "([a-z0-9-]+)"$/.exec(inner);
        if (!m) return { ok: false, reason: '{% ' + inner + ' %} is not a tag' };
        tag = { t: 'include', name: m[1] };
      } else {
        return { ok: false, reason: '{% ' + inner + ' %} is not a tag' };
      }
      if (alone) {
        // the text before loses the spaces/tabs after its last \n
        pushText(textStart, lineStart);
        toks.push(tag);
        let k = after;
        while (k < n) {
          const c = src.charCodeAt(k);
          if (c !== 32 && c !== 9) break;
          k++;
        }
        if (k < n && src.charCodeAt(k) === 10) k++;
        i = k;
        textStart = i;
      } else {
        pushText(textStart, j);
        toks.push(tag);
        i = after;
        textStart = i;
      }
    }
  }
  pushText(textStart, n);
  // Build the tree.
  const root = { type: 'root', nodes: [] };
  const stack = [root];
  function cur() { return stack[stack.length - 1]; }
  function curList() {
    const f = cur();
    if (f.type === 'if') return f.inElse ? f.els : f.then;
    return f.nodes;
  }
  for (const tok of toks) {
    if (tok.t === 0) { curList().push({ t: 0, s: tok.s }); continue; }
    if (tok.t === 1) { curList().push({ t: 1, path: tok.path, raw: tok.raw }); continue; }
    if (tok.t === 'for') { stack.push({ type: 'for', v: tok.v, path: tok.path, nodes: [] }); continue; }
    if (tok.t === 'if') { stack.push({ type: 'if', path: tok.path, neg: tok.neg, then: [], els: null, inElse: false }); continue; }
    if (tok.t === 'include') { curList().push({ t: 4, name: tok.name }); continue; }
    if (tok.t === 'else') {
      const f = cur();
      if (f.type !== 'if' || f.inElse) return { ok: false, reason: 'an else outside an if' };
      f.inElse = true;
      f.els = [];
      continue;
    }
    if (tok.t === 'endif') {
      const f = cur();
      if (f.type !== 'if') return { ok: false, reason: 'an endif with no open if' };
      stack.pop();
      curList().push({ t: 3, path: f.path, neg: f.neg, then: f.then, els: f.els });
      continue;
    }
    if (tok.t === 'endfor') {
      const f = cur();
      if (f.type !== 'for') return { ok: false, reason: 'an endfor with no open for' };
      stack.pop();
      curList().push({ t: 2, v: f.v, path: f.path, body: f.nodes });
      continue;
    }
  }
  if (stack.length !== 1) return { ok: false, reason: 'a ' + stack[stack.length - 1].type + ' is not closed' };
  return { ok: true, nodes: root.nodes };
}

function resolvePath(scope, path) {
  let val;
  let found = false;
  const first = path[0];
  const loops = scope.loops;
  for (let i = loops.length - 1; i >= 0; i--) {
    const fr = loops[i];
    if (first === 'loop') { val = fr.loop; found = true; break; }
    if (first === fr.v) { val = fr.val; found = true; break; }
  }
  if (!found) {
    if (Object.prototype.hasOwnProperty.call(scope.vals, first)) { val = scope.vals[first]; found = true; }
    else return undefined;
  }
  for (let k = 1; k < path.length; k++) {
    if (val === null || val === undefined) return undefined;
    const name = path[k];
    if (!Object.prototype.hasOwnProperty.call(val, name)) return undefined;
    val = val[name];
  }
  return val;
}

function writeValue(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out += ', ';
      out += writeValue(v[i]);
    }
    return out;
  }
  return '';
}

function isTruthy(v) {
  if (v === undefined || v === null || v === false) return false;
  if (v === '' || v === 0) return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

const EMPTY_NODES = [];
function renderNodes(nodes, scope, templates, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const node = nodes[ni];
    const t = node.t;
    if (t === 0) { out.push(node.s); continue; }
    if (t === 1) {
      const w = writeValue(resolvePath(scope, node.path));
      out.push(node.raw ? w : esc(w));
      continue;
    }
    if (t === 2) {
      const arr = resolvePath(scope, node.path);
      if (Array.isArray(arr)) {
        const len = arr.length;
        const loopObj = { index: 1, first: true, last: len === 1, length: len };
        const frame = { v: node.v, val: null, loop: loopObj };
        scope.loops.push(frame);
        for (let idx = 0; idx < len; idx++) {
          loopObj.index = idx + 1;
          loopObj.first = idx === 0;
          loopObj.last = idx === len - 1;
          frame.val = arr[idx];
          renderNodes(node.body, scope, templates, depth, out);
        }
        scope.loops.pop();
      }
      continue;
    }
    if (t === 3) {
      let cond = isTruthy(resolvePath(scope, node.path));
      if (node.neg) cond = !cond;
      renderNodes(cond ? node.then : (node.els || EMPTY_NODES), scope, templates, depth, out);
      continue;
    }
    // include
    if (depth < 8) {
      const tpl = templates.get(node.name);
      if (tpl) renderNodes(tpl, scope, templates, depth + 1, out);
    }
  }
}

// Compile a parsed template (node tree) into a straight-line render
// function, so a layout rendered for hundreds of pages pays no
// interpreter overhead (no per-node loop, dispatch or recursion for
// for/if bodies — those are inlined as JS control flow). The generated
// code calls the same resolvePath/writeValue/esc/isTruthy helpers, so
// its output is identical to renderNodes.
// Resolve a template path to a JS expression. When the first segment
// can never be a loop variable (it is not 'loop' and no template in this
// case uses it as a for-variable — collected at runtime), the value can
// only come from scope.vals, so a direct access chain replaces the
// resolvePath call (no loop scan, no hasOwnProperty chain, no path-array
// allocation per evaluation). Optional chaining reproduces resolvePath's
// behaviour for missing/null intermediates. Otherwise resolvePath is
// kept, so loop variables and 'loop' still resolve through the frames.
function accessExpr(path, loopVars) {
  const first = path[0];
  if (first === 'loop' || loopVars.has(first)) {
    return 'resolvePath(scope,' + JSON.stringify(path) + ')';
  }
  let expr = 'scope.vals.' + first;
  for (let k = 1; k < path.length; k++) expr += '?.' + path[k];
  return expr;
}

function compileNodes(nodes, parts, loopVars) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const node = nodes[ni];
    const t = node.t;
    if (t === 0) { parts.push('out.push(' + JSON.stringify(node.s) + ');'); continue; }
    if (t === 1) {
      const e = accessExpr(node.path, loopVars);
      parts.push(node.raw
        ? 'out.push(writeValue(' + e + '));'
        : 'out.push(esc(writeValue(' + e + ')));');
      continue;
    }
    if (t === 2) {
      const e = accessExpr(node.path, loopVars);
      parts.push('{const _a=' + e + ';if(Array.isArray(_a)){const _l=_a.length;const _o={index:1,first:true,last:_l===1,length:_l};const _f={v:' + JSON.stringify(node.v) + ',val:null,loop:_o};scope.loops.push(_f);for(let _i=0;_i<_l;_i++){_o.index=_i+1;_o.first=_i===0;_o.last=_i===_l-1;_f.val=_a[_i];');
      compileNodes(node.body, parts, loopVars);
      parts.push('}scope.loops.pop();}}');
      continue;
    }
    if (t === 3) {
      const e = accessExpr(node.path, loopVars);
      parts.push('{let _c=isTruthy(' + e + ');' + (node.neg ? '_c=!_c;' : '') + 'if(_c){');
      compileNodes(node.then, parts, loopVars);
      parts.push('}else{');
      compileNodes(node.els || EMPTY_NODES, parts, loopVars);
      parts.push('}}');
      continue;
    }
    // include
    parts.push('{if(depth<8){const _t=compiled.get(' + JSON.stringify(node.name) + ');if(_t)_t(scope,templates,compiled,depth+1,out);}}');
  }
}

function compileTemplate(nodes, loopVars) {
  const parts = [];
  compileNodes(nodes, parts, loopVars);
  // resolvePath/writeValue/esc/isTruthy/compiled are free variables, bound
  // below via the Function constructor's parameters.
  const fn = new Function('scope', 'templates', 'compiled', 'depth', 'out', 'resolvePath', 'writeValue', 'esc', 'isTruthy', parts.join(''));
  return (scope, templates, compiled, depth, out) => fn(scope, templates, compiled, depth, out, resolvePath, writeValue, esc, isTruthy);
}

// ---------- markdown ----------
// Escapable-after-backslash characters, as a 128-slot lookup by char code
// (faster than a Set in the inline hot loop).
const ESC_CODE = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESC_CODE[ch.charCodeAt(0)] = 1;

function resolveRel(dir, path) {
  const parts = [];
  if (dir !== '') {
    const dp = dir.split('/');
    for (let i = 0; i < dp.length; i++) parts.push(dp[i]);
  }
  const segs = path.split('/');
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s === '' || s === '.') continue;
    if (s === '..') { if (parts.length > 0) parts.pop(); continue; }
    parts.push(s);
  }
  return parts.join('/');
}

function resolveHref(target, ctx) {
  // Link targets repeat across hundreds of pages; the resolution depends
  // only on (srcDir, target) within a case, so memoize it. A cached
  // "broken" still records this page's broken-link report line, because
  // the report names the linking page.
  const cache = ctx.hrefCache;
  const key = ctx.srcDir + '\0' + target;
  const hit = cache.get(key);
  if (hit !== undefined) {
    if (hit === null) ctx.broken.add('broken-link ' + ctx.srcPath + ' -> ' + target);
    return hit === null ? target : hit;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) { cache.set(key, target); return target; }
  const c0 = target.charCodeAt(0);
  if (c0 === 47 || c0 === 35) { cache.set(key, target); return target; } // / or #
  let path = target, frag = '';
  const hi = target.indexOf('#');
  if (hi !== -1) { path = target.slice(0, hi); frag = target.slice(hi); }
  const resolved = resolveRel(ctx.srcDir, path);
  const url = ctx.pageBySource.get(resolved);
  if (url !== undefined) { const r = url + frag; cache.set(key, r); return r; }
  if (ctx.staticSet.has(resolved)) { const r = ctx.base + '/' + resolved + frag; cache.set(key, r); return r; }
  cache.set(key, null);
  ctx.broken.add('broken-link ' + ctx.srcPath + ' -> ' + target);
  return target;
}

const INLINE_TEST = /[\\`*\[&<>"']/;
const CONSTRUCT_TEST = /[\\`*[]/;
// One shared global regex for the inline scan. Safe to share across the
// (recursive) renderInline calls: every exec is preceded by setting
// lastIndex, so a nested call cannot corrupt the outer scan.
const INLINE_RE = /[\\`*\[&<>"']/g;
// A character at position p is escaped when an odd run of backslashes
// stands right before it (the backslashes pair up as escaped backslashes).
// Module level (takes s explicitly) so renderInline does not allocate two
// closures on every call.
function isEscaped(s, p) {
  let b = 0;
  let k = p - 1;
  while (k >= 0 && s.charCodeAt(k) === 92) { b++; k--; }
  return (b % 2) === 1;
}
// A * is single when it is the leftover of its run of unescaped stars:
// the run is paired off from its start, so a single star is the last
// star of an odd-length run (a lone star, or the third of ***).
function isSingleStar(s, n, p) {
  if (s.charCodeAt(p) !== 42 || isEscaped(s, p)) return false;
  let start2 = p;
  while (start2 > 0 && s.charCodeAt(start2 - 1) === 42 && !isEscaped(s, start2 - 1)) start2--;
  let end = p;
  while (end < n && s.charCodeAt(end) === 42 && !isEscaped(s, end)) end++;
  const len = end - start2;
  return (len % 2 === 1) && p === end - 1;
}

function renderInline(s, ctx) {
  const n = s.length;
  // Fast path: text with no special character at all is already its own
  // output — no construct can start and nothing needs escaping. One
  // native test replaces the regex creation, the exec, the slice and
  // the concatenation of the slow path.
  if (!INLINE_TEST.test(s)) return s;
  // Second fast path: text holding only HTML specials (&, <, >, ", ')
  // and no construct starter (\, `, *, [) renders as a plain escape —
  // one native replace instead of the jump-between-specials loop.
  if (!CONSTRUCT_TEST.test(s)) return esc(s);
  // Jump between special characters with a regex (scanned in C++), instead
  // of walking plain text one character at a time in JS. The regex matches
  // every character that needs attention — a construct starter (\\, `, *,
  // [) or an HTML special (&, <, >, ", ') — so the plain text between two
  // matches holds no special at all and is appended as-is, with no esc()
  // scan. The regex is shared (module level): every exec is preceded by
  // setting lastIndex, so a nested (recursive) call cannot corrupt the
  // outer scan.
  const re = INLINE_RE;
  let out = '';
  let i = 0;
  while (i < n) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) { out += s.slice(i); break; }
    const j = m.index;
    if (j > i) out += s.slice(i, j);
    const c = s.charCodeAt(j);
    if (c === 38) { out += '&amp;'; i = j + 1; continue; }
    if (c === 60) { out += '&lt;'; i = j + 1; continue; }
    if (c === 62) { out += '&gt;'; i = j + 1; continue; }
    if (c === 34) { out += '&quot;'; i = j + 1; continue; }
    if (c === 39) { out += '&#39;'; i = j + 1; continue; }
    if (c === 92) { // backslash
      if (j + 1 < n && ESC_CODE[s.charCodeAt(j + 1)] === 1) {
        const nx = s.charCodeAt(j + 1);
        out += nx === 62 ? '&gt;' : s[j + 1];
        i = j + 2;
      } else {
        out += '\\';
        i = j + 1;
      }
      continue;
    }
    if (c === 96) { // ` code span
      // The closer is the next backtick, full stop: the baseline does not
      // skip an escaped backtick here (unlike strong/em/link, which do).
      // indexOf scans in C++ and is faster than the loop.
      const found = s.indexOf('`', j + 1);
      if (found !== -1 && found > j + 1) {
        out += '<code>' + esc(s.slice(j + 1, found)) + '</code>';
        i = found + 1;
      } else {
        out += '`';
        i = j + 1;
      }
      continue;
    }
    if (c === 42) { // *
      if (s.charCodeAt(j + 1) === 42) { // ** strong
        if (s.charCodeAt(j + 2) === 42 && s.charCodeAt(j + 3) === 42) { out += '**'; i = j + 2; continue; }
        // Find the closer with indexOf (native scan). When a found '**'
        // starts on an escaped star, resume at f+1, not f+2: the second
        // star of the escaped pair can itself open a '**' (e.g. in
        // '\***', the pair at f is escaped but the pair at f+1 closes).
        let found = -1;
        let k = j + 2;
        while (true) {
          const f = s.indexOf('**', k);
          if (f === -1 || f >= n - 1) break;
          if (!isEscaped(s, f)) { found = f; break; }
          k = f + 1;
        }
        if (found !== -1 && found > j + 2) {
          out += '<strong>' + renderInline(s.slice(j + 2, found), ctx) + '</strong>';
          i = found + 2;
        } else {
          out += '**';
          i = j + 2;
        }
        continue;
      }
      if (!isSingleStar(s, n, j)) { out += '*'; i = j + 1; continue; }
      // Em closer: indexOf for the next star, keeping only single stars.
      let found = -1;
      let k = j + 1;
      while (true) {
        const f = s.indexOf('*', k);
        if (f === -1) break;
        if (isSingleStar(s, n, f)) { found = f; break; }
        k = f + 1;
      }
      if (found !== -1 && found > j + 1) {
        out += '<em>' + renderInline(s.slice(j + 1, found), ctx) + '</em>';
        i = found + 1;
      } else {
        out += '*';
        i = j + 1;
      }
      continue;
    }
    // [ link
    let k = j + 1, closeBracket = -1;
    while (k < n) {
      if (s.charCodeAt(k) === 92 && k + 1 < n && ESC_CODE[s.charCodeAt(k + 1)] === 1) { k += 2; continue; }
      if (s.charCodeAt(k) === 93) { closeBracket = k; break; }
      k++;
    }
    if (closeBracket !== -1 && s.charCodeAt(closeBracket + 1) === 40) {
      const closeParen = s.indexOf(')', closeBracket + 2);
      if (closeParen !== -1) {
        const target = s.slice(closeBracket + 2, closeParen);
        if (target !== '' && target.indexOf(' ') === -1 && target.indexOf('\t') === -1 &&
            target.indexOf('\n') === -1 && target.indexOf('\r') === -1) {
          const text = renderInline(s.slice(j + 1, closeBracket), ctx);
          out += '<a href="' + esc(resolveHref(target, ctx)) + '">' + text + '</a>';
          i = closeParen + 1;
          continue;
        }
      }
    }
    out += '[';
    i = j + 1;
  }
  return out;
}

function isBlankLine(l) {
  for (let i = 0; i < l.length; i++) {
    const c = l.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function fenceStart(line) {
  // returns the language ('' when none) or null when not a fence
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    const ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
               c === 95 || c === 43 || c === 45;
    if (!ok) break;
    j++;
  }
  for (let k = j; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, j);
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function headingOf(line) {
  // returns {level, text} or null
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let j = n;
  while (j < line.length) {
    const cc = line.charCodeAt(j);
    if (cc !== 32 && cc !== 9) break;
    j++;
  }
  if (j >= line.length) return null;
  let text = line.slice(j);
  // drop trailing spaces/tabs
  let e = text.length;
  while (e > 0) {
    const cc = text.charCodeAt(e - 1);
    if (cc !== 32 && cc !== 9) break;
    e--;
  }
  text = text.slice(0, e);
  if (text === '') return null;
  return { level: n, text };
}

function isBreakLine(line) {
  // '---' or '***' then only spaces/tabs
  if (line.length < 3) return false;
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function listStart(line) {
  // returns {kind:'ul'|'ol', num, text} or null
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) {
    return { kind: 'ul', num: 0, text: line.slice(2) };
  }
  if (c0 >= 48 && c0 <= 57) {
    let j = 0;
    while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
    if (j < line.length && line.charCodeAt(j) === 46 && line.charCodeAt(j + 1) === 32) {
      return { kind: 'ol', num: parseInt(line.slice(0, j), 10), text: line.slice(j + 2) };
    }
  }
  return null;
}

function isContinuation(line) {
  // two or more spaces then a non-space
  if (line.length < 3) return false;
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let j = 2;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  return j < line.length;
}

function trimLine(l) {
  let a = 0, b = l.length;
  while (a < b) {
    const c = l.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = l.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return l.slice(a, b);
}

function renderMarkdown(body, ctx) {
  const lines = body.split('\n');
  const n = lines.length;
  const blocks = [];
  const toc = [];
  let excerpt = '';
  let excerptSet = false;
  const headingIds = new Map();
  // word count on the raw body
  let words = 0;
  let inWord = false;
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    const ws = c === 32 || (c >= 9 && c <= 13);
    if (!ws && !inWord) { words++; inWord = true; }
    else if (ws) inWord = false;
  }
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
    // fence
    const lang = fenceStart(line);
    if (lang !== null) {
      const fenceLines = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) {
        fenceLines.push(lines[i]);
        i++;
      }
      if (i < n) i++; // skip the closing fence
      // Escape the joined content in one call instead of once per line:
      // esc only touches &, <, >, ", ' and never '\n', so escaping the
      // joined text is identical to escaping each line then joining.
      const content = fenceLines.length ? esc(fenceLines.join('\n') + '\n') : '';
      blocks.push('<pre><code' + (lang !== '' ? ' class="language-' + lang + '"' : '') + '>' + content + '</code></pre>');
      continue;
    }
    // heading
    const hd = headingOf(line);
    if (hd) {
      const base = slugOf(hd.text);
      const cnt = (headingIds.get(base) || 0) + 1;
      headingIds.set(base, cnt);
      const id = cnt === 1 ? base : base + '-' + cnt;
      const html = renderInline(hd.text, ctx);
      if (hd.level === 2 || hd.level === 3) toc.push({ level: hd.level, id, html });
      blocks.push('<h' + hd.level + ' id="' + id + '">' + html + '</h' + hd.level + '>');
      i++;
      continue;
    }
    // thematic break
    if (isBreakLine(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    // blockquote
    if (line.charCodeAt(0) === 62) {
      const parts = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let t = lines[i].slice(1);
        if (t.charCodeAt(0) === 32) t = t.slice(1);
        t = trimLine(t);
        if (t !== '') parts.push(t);
        i++;
      }
      if (parts.length === 0) blocks.push('<blockquote>\n</blockquote>');
      else blocks.push('<blockquote>\n<p>' + renderInline(parts.join('\n'), ctx) + '</p>\n</blockquote>');
      continue;
    }
    // list
    const ls = listStart(line);
    if (ls) {
      const kind = ls.kind;
      const items = [];
      let firstNum = ls.num;
      let text = ls.text;
      i++;
      while (i < n) {
        const l2 = lines[i];
        if (isBlankLine(l2)) break;
        const ls2 = listStart(l2);
        if (ls2 && ls2.kind === kind) {
          items.push(text);
          text = ls2.text;
          i++;
          continue;
        }
        if (isContinuation(l2)) {
          text += '\n' + trimLine(l2);
          i++;
          continue;
        }
        break;
      }
      items.push(text);
      const lis = [];
      for (let k = 0; k < items.length; k++) lis.push('<li>' + renderInline(items[k], ctx) + '</li>');
      const html = (kind === 'ul' ? '<ul>\n' : (firstNum === 1 ? '<ol>\n' : '<ol start="' + firstNum + '">\n')) + lis.join('\n') + '\n' + (kind === 'ul' ? '</ul>' : '</ol>');
      blocks.push(html);
      continue;
    }
    // paragraph: lines up to a blank line, a fence, a heading or a break
    const parts = [trimLine(line)];
    i++;
    while (i < n) {
      const l2 = lines[i];
      if (isBlankLine(l2)) break;
      if (fenceStart(l2) !== null) break;
      if (headingOf(l2)) break;
      if (isBreakLine(l2)) break;
      parts.push(trimLine(l2));
      i++;
    }
    const inline = renderInline(parts.join('\n'), ctx);
    if (!excerptSet) { excerpt = inline; excerptSet = true; }
    blocks.push('<p>' + inline + '</p>');
  }
  return { html: blocks.length ? blocks.join('\n') + '\n' : '', toc, excerpt, words };
}

// ---------- front matter ----------
function normalizeLineEndings(s) {
  if (s.indexOf('\r') === -1) return s;
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}


function parseQuoted(value, key) {
  let out = '';
  let i = 1;
  while (i < value.length) {
    const c = value[i];
    if (c === '\\') {
      if (i + 1 >= value.length) {
        return { ok: false, reason: 'key "' + key + '": a quoted string is not closed' };
      }
      const n = value[i + 1];
      if (n === '"') { out += '"'; i += 2; }
      else if (n === '\\') { out += '\\'; i += 2; }
      else {
        return { ok: false, reason: 'key "' + key + '": a quoted string holds an escape other than \\" or \\\\' };
      }
    } else if (c === '"') {
      if (i + 1 < value.length) {
        return { ok: false, reason: 'key "' + key + '": a quoted string is not closed' };
      }
      return { ok: true, str: out };
    } else {
      out += c;
      i++;
    }
  }
  return { ok: false, reason: 'key "' + key + '": a quoted string is not closed' };
}

function validateKey(key, value) {
  // returns {ok, val} or {ok:false, reason}
  if (value === '') {
    return { ok: false, reason: 'key "' + key + '" has no value' };
  }
  if (key === 'title' || key === 'summary') {
    const c0 = value.charCodeAt(0);
    if (c0 === 34) { // "
      const q = parseQuoted(value, key);
      if (!q.ok) return q;
      return { ok: true, val: q.str };
    }
    if (c0 === 91) { // [
      return { ok: false, reason: 'key "' + key + '": a bare string opens on [' };
    }
    return { ok: true, val: value };
  }
  if (key === 'date') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!m) return { ok: false, reason: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12) return { ok: false, reason: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    const dim = MONTH_DAYS[mo - 1] + (mo === 2 && isLeap(y) ? 1 : 0);
    if (d < 1 || d > dim) return { ok: false, reason: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    if (y < 1970 || y > 2099) return { ok: false, reason: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    return { ok: true, val: value };
  }
  if (key === 'tags') {
    if (value.charCodeAt(0) !== 91 || value.charCodeAt(value.length - 1) !== 93) {
      return { ok: false, reason: 'key "tags": not a list [a, b]' };
    }
    const inner = value.slice(1, -1);
    const tags = [];
    if (inner !== '') {
      const parts = inner.split(',');
      for (let i = 0; i < parts.length; i++) {
        const t = trimLine(parts[i]);
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
          return { ok: false, reason: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
        tags.push(t);
      }
    }
    return { ok: true, val: tags };
  }
  if (key === 'draft') {
    if (value === 'true') return { ok: true, val: true };
    if (value === 'false') return { ok: true, val: false };
    return { ok: false, reason: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    let ok = value.length > 0;
    if (ok) {
      for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        const good = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45;
        if (!good) { ok = false; break; }
      }
    }
    if (!ok) return { ok: false, reason: 'key "layout": not a template name' };
    return { ok: true, val: value };
  }
  if (key === 'slug') {
    if (!isValidSlug(value)) return { ok: false, reason: 'key "slug": not a slug' };
    return { ok: true, val: value };
  }
  return { ok: false, reason: 'unknown key "' + key + '"' };
}

function isValidSlug(s) {
  if (s.length === 0 || s.length > 64) return false;
  let prevDash = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 97 && c <= 122) { prevDash = false; continue; }
    if (c >= 48 && c <= 57) { prevDash = false; continue; }
    if (c === 45) {
      if (prevDash) return false;
      prevDash = true;
      continue;
    }
    return false;
  }
  if (s.charCodeAt(0) === 45 || s.charCodeAt(s.length - 1) === 45) return false;
  return true;
}

const KNOWN_KEYS = new Set(['title', 'summary', 'date', 'tags', 'draft', 'layout', 'slug']);

function parseFrontMatter(content) {
  // Only the front matter (a few lines at the top) is split; the body is
  // sliced out directly instead of splitting the whole file and joining
  // it back. Semantics match the line-based version: the first line must
  // be exactly '---', the closing line exactly '---', and the body is
  // everything after the closing line.
  const nl0 = content.indexOf('\n');
  const firstLine = nl0 === -1 ? content : content.slice(0, nl0);
  if (firstLine !== '---') {
    return { ok: false, reason: 'no front matter' };
  }
  // Find the closing '---' line: a '---' starting right after a '\n' and
  // followed by '\n' or the end of the string. C is its first '-'. Search
  // from nl0 (the '\n' ending the opening line) so a closing '---' on
  // line 2 is found.
  let C = -1;
  let searchFrom = nl0;
  while (true) {
    const idx = content.indexOf('\n---', searchFrom);
    if (idx === -1) break;
    const after = idx + 4;
    if (after === content.length || content.charCodeAt(after) === 10) { C = idx + 1; break; }
    searchFrom = idx + 1;
  }
  if (C === -1) {
    return { ok: false, reason: 'the front matter is not closed' };
  }
  const fmStart = nl0 + 1;
  const fmText = C - 1 >= fmStart ? content.slice(fmStart, C - 1) : '';
  const fmLines = fmText === '' ? [] : fmText.split('\n');
  const data = {};
  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i];
    if (isBlankLine(line)) continue;
    if (line.charCodeAt(0) === 35) continue; // comment
    // 'key: value' is a key, a colon, one space and the value; a bare
    // 'key:' (empty value) is also a line, but 'key:value' is not.
    const m = /^([a-z_]+):( (.*))?$/.exec(line);
    if (!m) {
      return { ok: false, reason: 'line ' + (i + 2) + ' is not "key: value"' };
    }
    const key = m[1];
    let value = m[3] === undefined ? '' : m[3];
    // drop trailing spaces/tabs
    let ve = value.length;
    while (ve > 0) {
      const vc = value.charCodeAt(ve - 1);
      if (vc !== 32 && vc !== 9) break;
      ve--;
    }
    value = value.slice(0, ve);
    if (!KNOWN_KEYS.has(key)) {
      return { ok: false, reason: 'unknown key "' + key + '"' };
    }
    if (key in data) {
      return { ok: false, reason: 'key "' + key + '" is given twice' };
    }
    const v = validateKey(key, value);
    if (!v.ok) return { ok: false, reason: v.reason };
    data[key] = v.val;
  }
  if (!('title' in data)) {
    return { ok: false, reason: 'no title' };
  }
  // Body starts after the closing '---' line (and its '\n', if any).
  const afterClose = C + 3;
  const body = afterClose >= content.length ? '' : (content.charCodeAt(afterClose) === 10 ? content.slice(afterClose + 1) : '');
  return { ok: true, data, body };
}

// ---------- build ----------
function dateLongOf(dateStr) {
  if (!dateStr) return '';
  const y = +dateStr.slice(0, 4), m = +dateStr.slice(5, 7), d = +dateStr.slice(8, 10);
  return d + ' ' + MONTHS[m - 1] + ' ' + y;
}

export function run(input) {
  const site = input.site;
  const base = site.base_url.replace(/\/+$/, '');
  const perPage = site.per_page;
  const recentCount = site.recent;
  const output = {};
  const report = [];
  const broken = new Set();
  const hrefCache = new Map();

  // templates, parsed in code-unit order of name
  const templates = new Map();
  const tmplNames = Object.keys(input.templates).sort();
  for (let i = 0; i < tmplNames.length; i++) {
    const name = tmplNames[i];
    const p = parseTemplate(input.templates[name]);
    if (!p.ok) report.push('template "' + name + '": ' + p.reason);
    else templates.set(name, p.nodes);
  }
  // compiled render functions, one per parsed template. Collect every
  // for-variable name used by any template first: a path whose first
  // segment is never a for-variable can be resolved by direct access
  // (see accessExpr); 'loop' and any for-variable keep resolvePath.
  const loopVars = new Set();
  (function collect(nodes) {
    for (const nd of nodes) {
      if (nd.t === 2) { loopVars.add(nd.v); collect(nd.body); }
      else if (nd.t === 3) { collect(nd.then); if (nd.els) collect(nd.els); }
    }
  })([...templates.values()].flat());
  const compiled = new Map();
  for (const [name, nodes] of templates) compiled.set(name, compileTemplate(nodes, loopVars));

  // sources, sorted by path in code-unit order
  const files = input.files.slice().sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const sources = [];
  const staticFiles = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) sources.push(f);
    else staticFiles.push(f);
  }

  // front matter + checks, in source order
  const kept = [];
  const usedSlugs = new Map();
  usedSlugs.set('', new Set(['posts', 'tags', 'page']));
  for (let s = 0; s < sources.length; s++) {
    const src = sources[s];
    const norm = normalizeLineEndings(src.content);
    const fm = parseFrontMatter(norm);
    if (!fm.ok) { report.push('refused ' + src.path + ': ' + fm.reason); continue; }
    const data = fm.data;
    const slashIdx = src.path.lastIndexOf('/');
    const srcDir = slashIdx === -1 ? '' : src.path.slice(0, slashIdx);
    const isPost = srcDir === 'posts' || srcDir.startsWith('posts/');
    if (srcDir === 'tags' || srcDir.startsWith('tags/')) {
      report.push('refused ' + src.path + ': tags/ is the generator\'s own');
      continue;
    }
    if (srcDir === 'page' || srcDir.startsWith('page/')) {
      report.push('refused ' + src.path + ': page/ is the generator\'s own');
      continue;
    }
    if (isPost && !data.date) {
      report.push('refused ' + src.path + ': a post needs a date');
      continue;
    }
    const layoutName = data.layout || (isPost ? 'post' : 'page');
    if (!templates.has(layoutName)) {
      report.push('refused ' + src.path + ': layout "' + layoutName + '" is no template that parses');
      continue;
    }
    if (data.draft === true) {
      report.push('draft ' + src.path);
      continue;
    }
    const dir = isPost ? 'posts' : srcDir;
    let slugSet = usedSlugs.get(dir);
    if (!slugSet) { slugSet = new Set(); usedSlugs.set(dir, slugSet); }
    const baseSlug = data.slug || slugOf(data.title);
    let slug = baseSlug;
    let n = 2;
    while (slugSet.has(slug)) { slug = baseSlug + '-' + n; n++; }
    slugSet.add(slug);
    const outPath = dir === '' ? slug + '/index.html' : dir + '/' + slug + '/index.html';
    const url = dir === '' ? base + '/' + slug + '/' : base + '/' + dir + '/' + slug + '/';
    kept.push({
      path: src.path, srcDir, isPost, dir, slug, outPath, url,
      data, body: fm.body, layoutName
    });
  }

  // markdown for each kept source
  const pageBySource = new Map();
  const staticSet = new Set();
  for (let i = 0; i < staticFiles.length; i++) staticSet.add(staticFiles[i].path);
  for (let i = 0; i < kept.length; i++) pageBySource.set(kept[i].path, kept[i].url);
  for (let i = 0; i < kept.length; i++) {
    const k = kept[i];
    const ctx = { srcPath: k.path, srcDir: k.srcDir, pageBySource, staticSet, base, broken, hrefCache };
    const md = renderMarkdown(k.body, ctx);
    k.content = md.html;
    k.toc = md.toc;
    k.excerpt = md.excerpt;
    k.readingMinutes = Math.max(1, Math.ceil(md.words / 200));
  }

  // collections: posts newest date first, equal dates by slug
  const posts = [];
  for (let i = 0; i < kept.length; i++) if (kept[i].isPost) posts.push(kept[i]);
  posts.sort((a, b) => {
    if (a.data.date !== b.data.date) return a.data.date < b.data.date ? 1 : -1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  for (let i = 0; i < posts.length; i++) {
    posts[i].newer = i === 0 ? null : posts[i - 1];
    posts[i].older = i === posts.length - 1 ? null : posts[i + 1];
  }

  // tags
  const tagBySlug = new Map();
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    const tags = p.data.tags || [];
    const seenSlugs = new Set();
    for (let j = 0; j < tags.length; j++) {
      const name = tags[j];
      const slug = slugOf(name);
      if (seenSlugs.has(slug)) continue;
      seenSlugs.add(slug);
      if (!tagBySlug.has(slug)) {
        tagBySlug.set(slug, { name, slug, url: base + '/tags/' + slug + '/', count: 0, posts: [] });
      }
      const t = tagBySlug.get(slug);
      t.count++;
      t.posts.push(p);
    }
  }
  const tags = Array.from(tagBySlug.values());
  tags.sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  const tagsForTpl = tags.map(t => ({ name: t.name, slug: t.slug, url: t.url, count: t.count }));

  // recent
  const recent = posts.slice(0, recentCount);

  // card builder
  function cardOf(k) {
    const cardTags = [];
    const seenCardSlugs = new Set();
    const tags = k.data.tags || [];
    for (let j = 0; j < tags.length; j++) {
      const slug = slugOf(tags[j]);
      if (seenCardSlugs.has(slug)) continue;
      seenCardSlugs.add(slug);
      const t = tagBySlug.get(slug);
      if (t) cardTags.push({ name: t.name, slug: t.slug, url: t.url });
      else cardTags.push({ name: tags[j], slug, url: '' });
    }
    return {
      title: k.data.title,
      url: k.url,
      date: k.data.date || '',
      date_long: dateLongOf(k.data.date || ''),
      summary: k.data.summary || '',
      excerpt: k.excerpt,
      reading_minutes: k.readingMinutes,
      tags: cardTags
    };
  }
  const cardByPage = new Map();
  for (let i = 0; i < kept.length; i++) cardByPage.set(kept[i], cardOf(kept[i]));

  function pageValueOf(k) {
    const card = cardByPage.get(k);
    const page = {
      title: card.title, url: card.url, date: card.date, date_long: card.date_long,
      summary: card.summary, excerpt: card.excerpt, reading_minutes: card.reading_minutes,
      tags: card.tags,
      slug: k.slug, content: k.content, toc: k.toc,
      is_post: k.isPost,
      newer: null, older: null
    };
    if (k.isPost) {
      if (k.newer) {
        const nc = cardByPage.get(k.newer);
        page.newer = { title: nc.title, url: nc.url, date: nc.date, date_long: nc.date_long };
      }
      if (k.older) {
        const oc = cardByPage.get(k.older);
        page.older = { title: oc.title, url: oc.url, date: oc.date, date_long: oc.date_long };
      }
    }
    return page;
  }

  const siteTpl = { title: site.title, base_url: base };
  const recentCards = recent.map(r => cardByPage.get(r));
  // One reusable render context per layout family: only `page` changes
  // per page, and for/if bodies push/pop their frames, so `loops` is
  // empty again after each render.
  const layoutCtx = { vals: { site: siteTpl, tags: tagsForTpl, recent: recentCards, page: null }, loops: [] };

  // layouts: every page through its layout
  for (let i = 0; i < kept.length; i++) {
    const k = kept[i];
    const fn = compiled.get(k.layoutName);
    if (!fn) continue;
    layoutCtx.vals.page = pageValueOf(k);
    const _o1 = []; fn(layoutCtx, templates, compiled, 0, _o1); output[k.outPath] = _o1.join('');
  }

  // index pages
  const indexFn = compiled.get('index');
  if (indexFn) {
    const total = Math.max(1, Math.ceil(posts.length / perPage));
    for (let pg = 1; pg <= total; pg++) {
      const start = (pg - 1) * perPage;
      const pagePosts = posts.slice(start, start + perPage).map(p => cardByPage.get(p));
      const pager = {
        number: pg, total,
        url: pg === 1 ? base + '/' : base + '/page/' + pg + '/',
        newer_url: pg === 1 ? '' : (pg === 2 ? base + '/' : base + '/page/' + (pg - 1) + '/'),
        older_url: pg === total ? '' : base + '/page/' + (pg + 1) + '/'
      };
      const ctx = { vals: { site: siteTpl, tags: tagsForTpl, recent: recentCards, posts: pagePosts, pager }, loops: [] };
      const outPath = pg === 1 ? 'index.html' : 'page/' + pg + '/index.html';
      const _o2 = []; indexFn(ctx, templates, compiled, 0, _o2); output[outPath] = _o2.join('');
    }
  }

  // tag pages + tags index
  const tagFn = compiled.get('tag');
  if (tagFn) {
    for (let i = 0; i < tags.length; i++) {
      const t = tags[i];
      const tagVal = {
        name: t.name, slug: t.slug, url: t.url, count: t.count,
        posts: t.posts.map(p => cardByPage.get(p))
      };
      const ctx = { vals: { site: siteTpl, tags: tagsForTpl, recent: recentCards, tag: tagVal }, loops: [] };
      const _o3 = []; tagFn(ctx, templates, compiled, 0, _o3); output['tags/' + t.slug + '/index.html'] = _o3.join('');
    }
  }
  const tagsFn = compiled.get('tags');
  if (tagsFn) {
    const ctx = { vals: { site: siteTpl, tags: tagsForTpl, recent: recentCards }, loops: [] };
    const _o4 = []; tagsFn(ctx, templates, compiled, 0, _o4); output['tags/index.html'] = _o4.join('');
  }

  // static files, unless a built page has that path
  let staticWritten = 0;
  for (let i = 0; i < staticFiles.length; i++) {
    const f = staticFiles[i];
    if (Object.prototype.hasOwnProperty.call(output, f.path)) {
      report.push('shadowed ' + f.path + ': a built page has its path');
      continue;
    }
    output[f.path] = f.content;
    staticWritten++;
  }

  // report
  const pagesCount = kept.length - posts.length;
  broken.forEach(line => report.push(line));
  report.sort();
  report.push('built ' + pagesCount + ' pages, ' + posts.length + ' posts, ' + tags.length + ' tags and ' + staticWritten + ' static files');
  output['build-report.txt'] = report.join('\n') + '\n';
  return output;
}
