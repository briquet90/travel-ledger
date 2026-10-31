/* 댕가계부 — 화면 아래에서 지내는 동반 강아지(골든 리트리버).
 *
 * 옆모습 강아지를 몸통·머리·귀·꼬리·다리 4개 관절로 나눠 두고, 매 프레임 관절 각도를 계산한다.
 * 자세 값(sit, lie, sniff…)은 목표값으로 부드럽게 다가가고, 귀·꼬리는 스프링처럼 따라 움직인다.
 * 행동: 숨쉬기·눈 깜빡임·꼬리 흔들기는 항상, 그 외에 서 있기/앉기/엎드리기/걷기/냄새 맡기/고개 갸웃/
 *       뒷발로 귀 긁기를 스스로 고른다. 기록 저장 → 폴짝폴짝 + 헥헥, 강아지 누르기 → 짖기 또는 도움말.
 * 입력 칸이 열리면 저장 버튼을 가리지 않게 왼쪽으로 비켜 앉는다. "움직임 줄이기" 설정이면 가만히 앉아만 있다.
 */
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const root = $(".companion");
  const mascot = $(".mascot");
  const headBubble = $(".mascot-bubble");
  if (!root) return;
  const mover = root.querySelector(".c-move");
  const flip = root.querySelector(".c-flip");
  const bubble = root.querySelector(".bubble");
  const part = (id) => document.getElementById(id);
  const P = {
    torso: part("c-torso"), breath: part("c-breath"), tail: part("c-tail"), head: part("c-head"),
    ear: part("c-ear"), lid: part("c-lid"), tongue: part("c-tongue"), mouth: part("c-mouth"), shadow: part("c-shadow"),
    bn: part("c-leg-bn"), bf: part("c-leg-bf"), fn: part("c-leg-fn"), ff: part("c-leg-ff"),
  };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const DOG_W = 120;          // 화면에 그려지는 폭(px)
  const SCALE = DOG_W / 160;  // viewBox 160 기준
  const GROUND = 108, HIP = [48, 74];
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ease = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

  /* ---------- 자세 상태 ---------- */
  const pose = { sit: 0, lie: 0, sniff: 0, tilt: 0, walk: 0, tailBase: -12, wagAmp: 14, wagSpeed: 7, pant: 0, scratch: 0, tuck: 0 };
  const target = { ...pose };
  let x = 24, facing = 1, speed = 0, phase = 0, t = 0, jumpY = 0, jumpV = 0, hops = 0;
  let ear = 8, earV = 0, lastHead = 0, blinkAt = 2, blinkT = 0, scratchPhase = 0, sniffPhase = 0;
  let state = "sit", stateEnd = 3, goal = null, after = null, lastTip = 0;

  function set(next) { Object.assign(target, next); }
  const POSES = {
    stand: { sit: 0, lie: 0, sniff: 0, tilt: 0, walk: 0, tailBase: -14, wagAmp: 10, wagSpeed: 6, pant: 0, scratch: 0 },
    sit: { sit: 1, lie: 0, sniff: 0, tilt: 0, walk: 0, tailBase: 6, wagAmp: 8, wagSpeed: 5, pant: 0, scratch: 0 },
    lie: { sit: 0, lie: 1, sniff: 0, tilt: 0, walk: 0, tailBase: 18, wagAmp: 4, wagSpeed: 3, pant: 0, scratch: 0 },
    sniff: { sit: 0, lie: 0, sniff: 1, tilt: 0, walk: 0, tailBase: -20, wagAmp: 12, wagSpeed: 8, pant: 0, scratch: 0 },
    happy: { sit: 0, lie: 0, sniff: 0, tilt: 0, walk: 0, tailBase: -38, wagAmp: 26, wagSpeed: 18, pant: 1, scratch: 0 },
  };

  /* ---------- 행동 고르기 ---------- */
  function bounds() {
    const w = innerWidth;
    const formOpen = !!document.querySelector("#entry-form:not([hidden])");
    // 입력 칸이 열려 있으면 오른쪽 아래 저장 버튼을 가리지 않게 왼쪽 절반 안에서만
    return [8, Math.max(40, (formOpen ? w * 0.45 : w) - DOG_W - 8)];
  }
  function begin(name, dur) { state = name; stateEnd = t + dur; }
  function walkTo(nx, then) {
    const [lo, hi] = bounds();
    goal = clamp(nx, lo, hi);
    if (Math.abs(goal - x) < 6) { goal = null; then && then(); return; }
    facing = goal > x ? 1 : -1;
    after = then || null;
    set(POSES.stand); target.walk = 1; target.tailBase = -18; target.wagAmp = 12;
    begin("walk", 60);
  }
  function chooseNext() {
    const [lo, hi] = bounds();
    if (x < lo - 1 || x > hi + 1) return walkTo(rnd(lo, hi));
    const r = Math.random();
    if (state === "lie") return r < 0.6 ? (set(POSES.sit), begin("sit", rnd(4, 8))) : (set(POSES.stand), begin("stand", rnd(2, 4)));
    if (state === "sit" && r < 0.25) return set(POSES.lie), begin("lie", rnd(8, 16));
    if (r < 0.34) return walkTo(rnd(lo, hi));
    if (r < 0.50) return set(POSES.sit), begin("sit", rnd(5, 10));
    if (r < 0.62) return set(POSES.sniff), begin("sniff", rnd(2.5, 4.5));
    if (r < 0.74) { set(POSES.sit); target.tilt = pick([-16, 14]); return begin("tilt", rnd(1.6, 2.6)); }
    if (r < 0.84) { set(POSES.sit); target.scratch = 1; return begin("scratch", rnd(1.6, 2.4)); }
    set(POSES.stand); begin("stand", rnd(2, 5));
  }

  /* ---------- 말풍선 ---------- */
  let bubbleTimer, headTimer;
  function say(text, ms = 2600) {
    bubble.textContent = text;
    bubble.hidden = false;
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => { bubble.hidden = true; }, ms);
  }
  function headSay(text) {
    if (!headBubble) return;
    headBubble.textContent = text; headBubble.hidden = false;
    mascot.classList.remove("hop"); void mascot.offsetWidth; mascot.classList.add("hop");
    clearTimeout(headTimer); headTimer = setTimeout(() => { headBubble.hidden = true; }, 2200);
  }
  function tip() {
    // 지금 화면에 맞는 도움말
    const visible = (sel) => { const el = document.querySelector(sel); return el && !el.hidden && el.offsetParent !== null; };
    if (visible("#pending-banner")) return "환율이 빈 기록이 있어요. '환율 채우기'를 눌러 주세요!";
    if (visible("#entry-form")) return pick(["외화는 결제일 환율로 자동 계산해요", "둘이 나눠 냈으면 '여러 명이 나눠 냈어요'!", "빠질 사람은 체크를 끄면 돼요"]);
    if (visible("#view-settle")) return pick(["'복사'를 눌러 송금 내역을 보내요", "통화를 바꿔서 정산해 볼 수도 있어요"]);
    if (visible("#view-trip")) return pick(["초대 링크로 친구랑 같이 적어요", "여행 끝나면 파일로 내보내 두세요"]);
    return pick(["+ 기록을 누르면 지출을 적어요", "산책 가요?", "간식도 식비예요!", "환율은 제가 찾아올게요"]);
  }

  /* ---------- 반응 ---------- */
  function celebrate(text) {
    goal = null;
    set(POSES.happy);
    begin("happy", 2.6);
    hops = 2; jumpV = -220;
    say(text, 2400);
    headSay(text);
  }
  document.addEventListener("ledger:saved", (ev) => {
    celebrate(ev.detail && ev.detail.kind === "transfer" ? pick(["정산 송금 확인!", "멍! 주고받기 끝"]) : pick(["멍! 기록했어요", "왈왈, 저장 완료!", "잘 적었어요!"]));
  });
  root.querySelector(".c-dog").addEventListener("click", () => {
    if (Math.random() < 0.5) {
      set(POSES.stand); target.pant = 1; target.tilt = 10; begin("bark", 1.2);
      say(pick(["멍!", "왈왈!", "멍멍!"]), 1200);
    } else {
      set(POSES.sit); target.tilt = -12; begin("tilt", 3);
      say(tip(), 3600);
    }
  });
  if (mascot) mascot.addEventListener("click", () => headSay(pick(["멍!", "왈!", "아래 강아지를 눌러 보세요", "산책 가요?"])));

  /* ---------- 관절 계산 ---------- */
  const rotAround = (px, py, deg, cx, cy) => {
    const r = deg * Math.PI / 180, dx = px - cx, dy = py - cy;
    return [cx + dx * Math.cos(r) - dy * Math.sin(r), cy + dx * Math.sin(r) + dy * Math.cos(r)];
  };
  const tf = (el, v) => el.setAttribute("transform", v);

  function render() {
    const sitDeg = -30 * pose.sit;                      // 몸통이 엉덩이를 축으로 들림
    const breathe = Math.sin(t * (pose.pant > .5 ? 9 : 2.4)) * (pose.pant > .5 ? .035 : .018);
    const stepBob = -Math.abs(Math.sin(phase)) * 1.8 * pose.walk;
    const drop = 14 * pose.sit + 17 * pose.lie + stepBob;
    tf(P.torso, `translate(0 ${drop.toFixed(2)}) rotate(${sitDeg.toFixed(2)} ${HIP[0]} ${HIP[1]})`);
    tf(P.breath, `translate(70 66) scale(1 ${(1 + breathe).toFixed(4)}) translate(-70 -66)`);

    // 꼬리
    const wag = Math.sin(t * pose.wagSpeed) * pose.wagAmp;
    tf(P.tail, `rotate(${(pose.tailBase + wag).toFixed(2)} 44 61)`);

    // 다리: 걷기 진자 + 앉기/엎드리기 접힘
    const swing = 24 * pose.walk;
    const legs = [
      [P.fn, 88, 72, phase, true], [P.ff, 94, 70, phase + Math.PI, true], [P.bn, 50, 76, phase + Math.PI, false], [P.bf, 56, 74, phase, false],
    ];
    for (const [el, lx, ly, lp, front] of legs) {
      const ph = Math.sin(lp);
      // 다리가 앞으로 나가는 동안(cos>0) 발을 들어 올려 짧아 보이게 → 걷는 느낌
      const lift = Math.max(0, Math.cos(lp)) * 0.16 * pose.walk;
      let [wx, wy] = rotAround(lx, ly, sitDeg, HIP[0], HIP[1]);
      wy += drop;
      let ang = ph * swing, sy = 1;
      if (front) {
        ang += -84 * pose.lie;
        const reach = clamp((GROUND - wy) / 34, .55, 1.6);
        sy = (reach - lift) * (1 - pose.lie) + .95 * pose.lie;
        if (el === P.fn) ang += -12 * pose.tuck;
      } else {
        ang += -72 * pose.sit - 80 * pose.lie;
        sy = 1 - lift - .38 * pose.sit - .2 * pose.lie;
        if (el === P.bn && pose.scratch > .05) { ang += (-40 + Math.sin(scratchPhase) * 22) * pose.scratch; sy -= .1 * pose.scratch; }
        ang += 10 * pose.tuck;
      }
      tf(el, `translate(${wx.toFixed(2)} ${wy.toFixed(2)}) rotate(${ang.toFixed(2)}) scale(1 ${sy.toFixed(3)})`);
    }

    // 머리: 목을 기준으로. 앉으면 고개를 세우고, 냄새 맡을 땐 숙이고, 귀 긁을 땐 기울인다.
    let [nx, ny] = rotAround(96, 58, sitDeg, HIP[0], HIP[1]);
    ny += drop + Math.sin(phase * 2) * .8 * pose.walk;
    const sniffBob = pose.sniff * Math.sin(sniffPhase) * 3;
    const head = sitDeg * 0.25 + 30 * pose.sniff + sniffBob + pose.tilt + 10 * pose.lie
      + 14 * pose.scratch + Math.sin(t * 0.9) * 2 * (1 - pose.walk);
    tf(P.head, `translate(${nx.toFixed(2)} ${(ny + 4 * pose.sniff).toFixed(2)}) rotate(${head.toFixed(2)})`);

    // 귀: 머리 움직임을 늦게 따라가는 스프링
    tf(P.ear, `translate(10 -24) rotate(${ear.toFixed(2)})`);
    lastHead = head;

    // 눈 깜빡임, 혀
    const lid = blinkT > 0 ? Math.sin(Math.min(1, blinkT / .14) * Math.PI) : 0;
    tf(P.lid, `translate(21 -19) scale(1 ${lid.toFixed(3)}) translate(-21 19)`);
    P.tongue.setAttribute("opacity", pose.pant.toFixed(2));
    tf(P.tongue, `translate(0 ${(Math.max(0, Math.sin(t * 9)) * 1.5 * pose.pant).toFixed(2)})`);
    P.shadow.setAttribute("rx", (40 + 6 * pose.lie - Math.min(14, -jumpY * .25)).toFixed(1));

    mover.style.transform = `translate3d(${x.toFixed(1)}px, ${jumpY.toFixed(1)}px, 0)`;
    flip.style.transform = facing < 0 ? "scaleX(-1)" : "none";
  }

  /* ---------- 프레임 ---------- */
  function step(dt) {
    t += dt;
    for (const k of Object.keys(pose)) pose[k] = ease(pose[k], target[k], k === "walk" ? 6 : k === "pant" ? 5 : 3.2, dt);

    // 걷기
    if (state === "walk" && goal !== null) {
      speed = ease(speed, 62, 3, dt);
      const dir = Math.sign(goal - x);
      x += dir * speed * dt;
      if ((dir > 0 && x >= goal) || (dir < 0 && x <= goal)) {
        x = goal; goal = null; target.walk = 0; speed = 0;
        const then = after; after = null;
        if (then) then(); else { set(POSES.stand); begin("stand", rnd(1, 2.5)); }
      }
    }
    phase += dt * (speed * 0.11 + 0.0001);

    // 점프
    if (hops > 0 || jumpY < 0) {
      jumpV += 900 * dt; jumpY += jumpV * dt;
      target.tuck = jumpY < -2 ? 1 : 0;
      if (jumpY >= 0) { jumpY = 0; hops -= 1; jumpV = hops > 0 ? -200 : 0; target.tuck = 0; }
    }

    // 귀 스프링: 머리가 갑자기 움직이면 반대로 흔들렸다 돌아옴
    const headVel = (lastHead - (step.prevHead ?? lastHead)) / Math.max(dt, 1e-3);
    step.prevHead = lastHead;
    const earTarget = 6 - headVel * 0.05 + Math.sin(phase * 2) * 4 * pose.walk + pose.scratch * Math.sin(scratchPhase) * 10;
    earV += ((earTarget - ear) * 120 - earV * 14) * dt;
    ear += earV * dt;
    ear = clamp(ear, -30, 40);

    scratchPhase += dt * 26 * pose.scratch;
    sniffPhase += dt * 11 * pose.sniff;

    // 깜빡임
    if (blinkT > 0) blinkT = Math.max(0, blinkT - dt);
    if (t > blinkAt) { blinkT = .14; blinkAt = t + (Math.random() < .2 ? .25 : rnd(2.2, 5.5)); }

    // 다음 행동
    if (state !== "walk" && t > stateEnd) {
      if (state === "happy" || state === "bark") { set(POSES.sit); target.pant = 0.6; begin("sit", 3); }
      else chooseNext();
    }
    // 가끔 도움말 (앉아 있을 때, 1분에 한 번 정도)
    if (state === "sit" && t - lastTip > 55 && Math.random() < dt / 20) { lastTip = t; say(tip(), 3800); }

    // 입력 칸이 열려 저장 버튼 쪽에 있으면 비켜 감
    const [lo, hi] = bounds();
    if (state !== "walk" && state !== "happy" && x > hi + 4) walkTo(hi - rnd(0, 30), () => { set(POSES.sit); begin("sit", rnd(4, 8)); });
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!document.hidden) { step(dt); render(); }
    requestAnimationFrame(frame);
  }

  // 시험용: 주소에 ?dogdebug 가 있을 때만 자세를 직접 지정할 수 있다.
  if (location.search.includes("dogdebug")) {
    window.__dog = {
      pose(name, extra = {}) { goal = null; set({ ...POSES[name === "tilt" || name === "scratch" ? "sit" : name], ...extra }); begin(name, 1e9); },
      walk(nx) { walkTo(nx, () => { set(POSES.stand); begin("stand", 1e9); }); },
      celebrate() { celebrate("멍! 기록했어요"); },
      state: () => ({ state, x: Math.round(x), facing }),
    };
  }

  x = 16; set(POSES.sit); Object.assign(pose, POSES.sit); begin("sit", 2.5);
  if (reduced) {
    // 움직임 줄이기: 앉아 있는 자세로 한 번만 그리고, 말풍선만 쓴다.
    render();
    return;
  }
  // 처음에는 화면 밖 왼쪽에서 걸어 들어온다.
  x = -DOG_W; facing = 1;
  walkTo(rnd(20, Math.min(160, innerWidth * 0.4)), () => { set(POSES.sit); begin("sit", rnd(3, 6)); say(pick(["멍! 오늘도 같이 적어요", "왔어요!", "꼬리 흔들흔들~"]), 2200); });
  requestAnimationFrame(frame);
})();
