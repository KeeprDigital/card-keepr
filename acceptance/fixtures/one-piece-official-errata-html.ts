/**
 * Retained from Bandai's public Official Errata surface on 2026-07-31.
 *
 * The fixture deliberately preserves the page's real dated-section,
 * card-heading, image, note, and Before/After structure. It is not a
 * normalized Card or Game Profile document.
 */
export const onePieceOfficialErrataHtml = `<!doctype html>
<html lang="en">
  <head>
    <title>Errata Cards − RULES｜ONE PIECE CARD GAME - Official Web Site</title>
  </head>
  <body id="rules">
    <main class="mainCol">
      <article>
        <h2 class="categoryTitle">RULES</h2>
        <section>
          <div class="pageTitCol">
            <div class="pageTitInner">
              <h3 class="pageTit">Errata Cards</h3>
              <div class="pageTitInfoCol"><span class="pageTitDate">May 16, 2025</span></div>
            </div>
          </div>
          <div class="contentsWrap">
            <p class="mtS">
              Errata Cards are cards which have their text changed due to misprints, to clarify translation or wording, or to adjust game balance.
              The Card Errata <span class="txtStrong">“After” text is applied to all game formats and takes precedence</span> over the original wording of the card.
            </p>

            <section class="contentsLCol" id="errata_15">
              <section class="contentsMCol mtM">
                <h4 class="mediumTit">May 16, 2025</h4>
              </section>
              <div class="detailCol mtS">
                <h5 class="smallTitRed">OP07-097 Vegapunk</h5>
                <div class="typographicalWrap mtS">
                  <div class="typographicalImg spWidthM centering"><img src="/images/rules/cards/20250516/OP07-097_p2.png" alt="OP09-058"></div>
                </div>
                <dl>
                  <dt class="txtBlack mtS">Note:</dt>
                  <dd>This correction applies in every game format.</dd>
                  <dt class="txtBlack mtS">Before:</dt>
                  <dd>This Leader cannot attack.<br>[Activate: Main] [Once Per Turn] You may rest 1 of your DON!! cards Select up to 1 {Egghead} typSelectup to 1 {Egghead} type card with a cost of 5 or less from your hand and play it or add it to the top of your Life cards face-up.</dd>
                  <dt class="txtBlack mtS">After:</dt>
                  <dd>This Leader cannot attack.<br>[Activate: Main] [Once Per Turn] You may rest 1 of your DON!! cards: Select up to 1 {Egghead} type card with a cost of 5 or less from your hand and play it or add it to the top of your Life cards face-up.</dd>
                </dl>
              </div>
            </section>

            <section class="contentsLCol">
              <section class="contentsMCol mtM">
                <h4 class="mediumTit">July 14, 2023</h4>
              </section>
              <div class="detailCol mtS" id="errata_10">
                <h5 class="smallTitRed">OP03-047 Zeff</h5>
                <div class="typographicalWrap mtS">
                  <div class="typographicalImg spWidthM centering"><img src="/images/rules/cards/20230714/op03-047_dummy.png" alt="OP03-047"></div>
                </div>
                <ul class="commonNoticeList isHalf">
                  <li>*Also applies to parallel card version.</li>
                </ul>
                <dl>
                  <dt class="txtBlack mtS">Before:</dt>
                  <dd>[DON!! x1] When this Character's attack deals damage to your opponent's Life, you may trash 7 cards from the top of your deck.<br>
                    [On Play] You may return up to 1 Character with a cost of 3 or less to the owner's hand, and trash 2 cards from the top of your deck.</dd>
                  <dt class="txtBlack mtS">After:</dt>
                  <dd>[DON!! x1] When this Character's attack deals damage to your opponent's Life, you may trash 7 cards from the top of your deck.<br>
                    [On Play] Return up to 1 Character with a cost of 3 or less to the owner's hand, and <span class="txtStrong">you may</span> trash 2 cards from the top of your deck.</dd>
                </dl>
              </div>
            </section>

            <section class="contentsLCol" id="errata_05">
              <section class="contentsMCol mtM">
                <h4 class="mediumTit">February 17, 2023</h4>
              </section>
              <section class="cardPackCol mtM">
                <ul class="cardFlexWrap errataPopupCol">
                  <li>
                    <a class="modalOpen" data-src="#nov_11_2022_OP01-001">
                      <img src="/images/rules/cards/20230217/op01-001_thumbnail.png" alt="OP01-001">
                    </a>
                    <div class="errataModal" id="nov_11_2022_OP01-001">
                      <h5 class="smallTitRed">February 17, 2023<br>OP01-001 Monkey D. Luffy</h5>
                      <div class="typographicalWrap mtM">
                        <div class="typographicalImg spWidthM centering">
                          <img src="/images/rules/cards/20230217/op01-001_dummy.png" alt="OP01-001">
                        </div>
                      </div>
                      <dl>
                        <dt class="txtBlack mtS">Before:</dt>
                        <dd>[On Play] Draw 1 card.</dd>
                        <dt class="txtBlack mtS">After:</dt>
                        <dd>[On Play] Draw 2 cards.</dd>
                      </dl>
                    </div>
                  </li>
                </ul>
              </section>
            </section>
          </div>
        </section>
      </article>
    </main>
    <footer>
      <img src="/renewal/images/common/sp/footer_illust_chara.webp" alt="">
    </footer>
  </body>
</html>`;

export const onePieceOfficialErrataShapeDriftHtml =
  onePieceOfficialErrataHtml.replace(
    '<div class="detailCol mtS">',
    '<div class="errataEntry mtS">',
  );
