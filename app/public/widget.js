/* 100x.broker swap widget. One line on any page:
 *   <div data-100x-swap data-pay="So11111111111111111111111111111111111111112" data-recv="<mint>" data-ref="<your wallet>"></div>
 *   <script src="https://swap.100x.broker/widget.js" async></script>
 * Every swap through it pays 1 bp per hop to the house and puts 10 bp per hop on a 100x long/short for the swapper;
 * data-ref earns the referral slice of the stake-pool deposits it drives. data-bad-beat="1" flips long and short. */
(function () {
  var ORIGIN = "https://swap.100x.broker";
  function mount(el) {
    if (el.getAttribute("data-100x-mounted")) return;
    el.setAttribute("data-100x-mounted", "1");
    var q = new URLSearchParams({ embed: "1" });
    ["pay", "recv", "ref"].forEach(function (k) { var v = el.getAttribute("data-" + k); if (v) q.set(k, v); });
    if (el.getAttribute("data-bad-beat") === "1") q.set("badBeat", "1");
    var f = document.createElement("iframe");
    f.src = ORIGIN + "/?" + q.toString();
    f.title = "100x.broker swap";
    f.loading = "lazy";
    f.allow = "clipboard-write";
    f.style.cssText = "width:100%;max-width:440px;height:" + (el.getAttribute("data-height") || "720") + "px;border:0;border-radius:16px;background:transparent;display:block";
    el.appendChild(f);
  }
  function scan() { var els = document.querySelectorAll("[data-100x-swap]"); for (var i = 0; i < els.length; i++) mount(els[i]); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scan); else scan();
})();
