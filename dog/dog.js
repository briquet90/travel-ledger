/* 멍멍 여행가계부 — 움직이는 리트리버.
 * - 화면 아래를 가끔 산책한다(CSS 애니메이션).
 * - 기록을 저장하면(app.js 의 "ledger:saved" 이벤트) 말풍선을 달고 달려 지나가고, 위쪽 얼굴이 폴짝 뛴다.
 * - 위쪽 얼굴을 누르면 짖는다.
 * 움직임 줄이기 설정이면 걷지 않고 말풍선만 보인다.
 */
(() => {
  const walker = document.querySelector(".walker");
  const runBubble = document.querySelector(".walker .bubble");
  const mascot = document.querySelector(".mascot");
  const headBubble = document.querySelector(".mascot-bubble");
  if (!walker || !mascot) return;

  const SAVED = ["멍! 기록했어요", "왈왈, 저장 완료!", "잘 적었어요!", "꼬리 흔들흔들~"];
  const TRANSFER = ["정산 송금 확인!", "멍! 주고받기 끝"];
  const BARK = ["멍!", "왈!", "산책 가요?", "간식은 식비예요", "환율 보는 중…"];
  const pick = (list) => list[Math.floor(Math.random() * list.length)];

  let headTimer;
  function say(text) {
    headBubble.textContent = text;
    headBubble.hidden = false;
    mascot.classList.remove("hop"); void mascot.offsetWidth; mascot.classList.add("hop");
    clearTimeout(headTimer);
    headTimer = setTimeout(() => { headBubble.hidden = true; }, 2200);
  }

  function run(text) {
    runBubble.textContent = text;
    walker.classList.remove("run"); void walker.offsetWidth; walker.classList.add("run");
  }
  walker.addEventListener("animationend", (ev) => {
    if (ev.animationName === "dash") walker.classList.remove("run");
  });

  document.addEventListener("ledger:saved", (ev) => {
    const text = pick(ev.detail && ev.detail.kind === "transfer" ? TRANSFER : SAVED);
    say(text);
    run(text);
  });
  mascot.addEventListener("click", () => say(pick(BARK)));
})();
