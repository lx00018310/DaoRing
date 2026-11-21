"""Run against the production preview with Playwright for Python and local Chrome."""

import argparse
import json
from pathlib import Path

from playwright.sync_api import Page, expect, sync_playwright


def press(page: Page, selector: str) -> None:
    # DOM click keeps timing cases independent of frame-based pointer waits.
    page.locator(selector).evaluate("element => element.click()")


def cards(page: Page) -> list[str]:
    return page.locator(".hand-card").evaluate_all("cards => cards.map(card => card.dataset.configId)")


def place(page: Page, card: str, slot: int) -> None:
    press(page, f'.hand-card[data-config-id="{card}"]')
    press(page, f"#slot-{slot}")


def skip_turn(page: Page, expected: int) -> None:
    page.locator("#btn-run").evaluate("button => { button.click(); button.click(); }")
    press(page, "#btn-skip")
    page.clock.run_for(1)
    expect(page.locator("#burst-total")).to_have_text(str(expected))


def choose_branch(page: Page, branch: str) -> None:
    assert cards(page) == [], "A random reward arrived before the choice."
    expect(page.locator("#btn-run")).to_be_disabled()
    choice = page.locator(f'.branch-card[data-id="{branch}"]')
    choice.evaluate("button => { button.click(); button.click(); }")
    assert cards(page) == [branch, "dao_gather"]


def reach_zenith(page: Page, branch: str, effects: list[str] | None = None) -> str:
    place(page, "dao_gather", 1)
    place(page, "dao_burst", 3)
    skip_turn(page, 43)
    choose_branch(page, branch)
    place(page, branch, 0 if branch == "dao_chain" else 2)
    skip_turn(page, 86 if branch == "dao_chain" else 78)
    title = page.locator("#modal-title").inner_text()
    if effects:
        for effect in effects:
            assert effect in page.locator("#modal-card").inner_text()
    assert cards(page) == ["dao_gather"], "Zenith rewards should wait for confirmation."
    page.locator("#btn-enter-zenith").evaluate("button => { button.click(); button.click(); }")
    other = "dao_crit" if branch == "dao_chain" else "dao_chain"
    assert cards(page) == ["dao_gather", other, "dao_sword"]
    return title


def add_other_branch(page: Page, initial_choice: str) -> None:
    if initial_choice == "dao_chain":
        place(page, "dao_crit", 2)
    else:
        place(page, "dao_chain", 0)


def during(page: Page, selector: str, max_ms: int) -> int:
    for elapsed in range(0, max_ms + 1, 20):
        if page.locator(selector).count():
            return elapsed
        page.clock.run_for(20)
    raise AssertionError(f"{selector} did not appear within {max_ms} ms")


def capture(page: Page, evidence: Path | None, name: str) -> None:
    if evidence:
        page.screenshot(path=str(evidence / f"{name}.png"), timeout=5000)


def layout(browser, url: str, evidence: Path | None) -> None:
    for width, height in ((320, 568), (360, 640), (390, 844), (667, 375), (1280, 720)):
        page = browser.new_page(viewport={"width": width, "height": height}, has_touch=width < 700)
        page.goto(url)
        for slot in range(4):
            page.locator('.hand-card[data-config-id="dao_burst"]').click()
            target = page.locator(f"#slot-{slot}")
            target.scroll_into_view_if_needed()
            assert target.evaluate("""el => {
              const rect = el.getBoundingClientRect();
              return el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
            }"""), f"{width}x{height}: slot {slot} blocked"
            target.click()
            expect(target).to_contain_text("灵爆术")
            if (width, height, slot) == (320, 568, 0):
                capture(page, evidence, "short-portrait")
            target.click()
            page.locator("#menu-recall").click()
        expect(page.locator("#btn-run")).to_be_enabled()
        page.close()
        print(f"Pointer operates all four slots at {width}x{height}")


def routes(page: Page, evidence: Path | None) -> None:
    title = reach_zenith(page, "dao_chain", ["前2次", "本次耗气 0"])
    assert "玄黄祥云劫" in title
    expect(page.locator("#stat-cost")).to_contain_text("余 2 次")
    skip_turn(page, 86)
    expect(page.locator("#stat-cost")).to_contain_text("余 1 次")
    skip_turn(page, 86)
    expect(page.locator("#stat-cost")).to_have_text("145")
    add_other_branch(page, "dao_chain")
    press(page, "#btn-run")
    during(page, '[data-pulse="P1"]', 800)
    assert page.locator('.energy-pulse').count() == 2
    capture(page, evidence, "real-split")
    during(page, "#conv-3.active", 3200)
    assert page.locator(".converge-line.active").count() == 1
    assert page.locator("#slot-3.converge-source").count() == 1
    page.clock.run_for(120)
    capture(page, evidence, "finale-converge")
    during(page, ".meridian-path.active", 800)
    capture(page, evidence, "finale-meridian")
    during(page, "#cocoon-hull.active", 850)
    capture(page, evidence, "finale-cocoon")
    during(page, "#shockwave-ring-1.active", 850)
    during(page, "#finale-title:not([hidden])", 950)
    assert not page.locator("#modal-layer").is_visible()
    during(page, "#btn-replay", 1350)
    expect(page.locator(".modal-score-val")).to_have_text("156")
    capture(page, evidence, "first-victory")

    for rng, branch, hazard, score in (
        (0.4, "dao_crit", "九幽心魔劫", 312),
        (0.9, "dao_chain", "玄黄祥云劫", 156),
        (0.2, "dao_crit", "九霄神雷劫", 156),
    ):
        press(page, "#btn-replay")
        page.evaluate(f"Math.random = () => {rng}")
        effect = {"九幽心魔劫": "TTL", "玄黄祥云劫": "前2次", "九霄神雷劫": "增长加快"}[hazard]
        assert hazard in reach_zenith(page, branch, [effect])
        add_other_branch(page, branch)
        skip_turn(page, score)
        expect(page.locator(".modal-score-val")).to_have_text(str(score))

    records = page.evaluate("JSON.parse(localStorage.zt_demo_analytics)")
    victories = [r for r in records if r['event'] == 'run_end' and r['endType'] == 'VICTORY']
    assert [r['highestQi'] for r in victories] == [156, 312, 156, 156]
    for victory in victories:
        run = [r for r in records if r['runId'] == victory['runId']]
        for event in ("first_run", "first_card_placed", "first_release", "branch_chosen"):
            assert len([r for r in run if r['event'] == event]) == 1, (event, run)
        assert [r['stage'] for r in run if r['event'] == 'stage_clear'] == ['1-1', '1-2', '1-3']
        release = next(r for r in run if r['event'] == 'first_release')
        assert release['skipped'] and not release['watchedRelease']
    print("Both branches, three tribulations, finale frames, cross-run high score and telemetry passed")


def interruptions(page: Page) -> None:
    reach_zenith(page, "dao_chain")
    add_other_branch(page, "dao_chain")
    press(page, "#btn-run")
    during(page, ".converge-line.active", 3200)
    press(page, "#btn-reset")
    page.clock.run_for(10_000)
    assert not page.locator("#modal-layer").is_visible()
    assert page.locator(".converge-line.active, .meridian-path.active, .energy-pulse, .float-notice, .screen-shake").count() == 0
    expect(page.locator("#dantian-core")).not_to_have_class("dantian-core gold")
    expect(page.locator("#stat-qi")).to_have_text("100")
    assert cards(page) == ["dao_gather", "dao_burst"]

    for phase in (".meridian-path.active", "#shockwave-ring-1.active"):
        reach_zenith(page, "dao_chain")
        add_other_branch(page, "dao_chain")
        press(page, "#btn-run")
        during(page, phase, 6500)
        page.evaluate("""() => {
          document.querySelector('#btn-skip').click();
          document.querySelector('#btn-reset').click();
        }""")
        page.clock.run_for(8000)
        assert page.locator(".converge-line.active, .meridian-path.active, .shockwave-ring.active, .screen-shake").count() == 0
        assert not page.locator("#modal-layer").is_visible()

    place(page, "dao_gather", 0)
    place(page, "dao_burst", 1)
    press(page, "#btn-run")
    page.clock.run_for(270)
    page.evaluate("""() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
      delete document.hidden;
    }""")
    page.clock.run_for(10)
    expect(page.locator("#burst-total")).to_have_text("43")
    choose_branch(page, "dao_crit")
    press(page, "#slot-1")
    press(page, "#menu-move")
    press(page, "#slot-3")
    press(page, '.hand-card[data-config-id="dao_gather"]')
    place(page, "dao_crit", 2)
    skip_turn(page, 78)
    print("Finale reset, tab visibility skip and off-guide placement recovery passed")


def interaction(page: Page, tmp_path: Path | None) -> None:
    page.locator("#btn-toggle-log").focus()
    page.keyboard.press("Tab")
    expect(page.locator("#slot-0")).to_be_focused()
    page.keyboard.press("Enter")
    expect(page.locator("#action-feedback")).to_contain_text("先选一张")
    page.locator(".hand-card").first.focus()
    page.keyboard.press("Space")
    expect(page.locator(".hand-card").first).to_be_focused()
    page.locator("#slot-1").focus()
    page.keyboard.press("Enter")
    page.keyboard.press("Enter")
    expect(page.locator("#menu-recall")).to_be_focused()
    page.keyboard.press("Escape")
    expect(page.locator("#slot-1")).to_be_focused()

    place(page, "dao_burst", 3)
    skip_turn(page, 43)
    expect(page.locator(".branch-card").first).to_be_focused()
    page.keyboard.press("Enter")
    assert cards(page) == ["dao_chain", "dao_gather"]
    press(page, '.hand-card[data-config-id="dao_chain"]')
    press(page, "#slot-1")
    expect(page.locator("#hint-bar")).to_contain_text("旧道韵")
    press(page, "#slot-0")
    expect(page.locator("#action-feedback")).to_contain_text("选择燃料")
    assert cards(page) == ["dao_chain", "dao_gather"]
    expect(page.locator("#slot-0")).to_contain_text("空槽")
    page.keyboard.press("Escape")

    place(page, "dao_chain", 0)
    skip_turn(page, 86)
    press(page, "#btn-enter-zenith")
    press(page, '.hand-card[data-config-id="dao_sword"]')
    press(page, "#slot-3")
    press(page, '.hand-card[data-config-id="dao_gather"]')
    assert cards(page) == ["dao_crit"]
    expect(page.locator("#slot-3")).to_contain_text("万剑诀")
    press(page, "#slot-0")
    press(page, "#menu-remove")
    press(page, '.hand-card[data-config-id="dao_crit"]')
    assert cards(page) == []
    expect(page.locator("#slot-0")).to_contain_text("空槽")

    press(page, "#btn-reset")
    for qi in (90, 60, 2):
        skip_turn(page, 0)
        expect(page.locator("#stat-qi")).to_have_text(str(qi))
    skip_turn(page, 0)
    expect(page.locator("#modal-card")).to_contain_text("本次运转需要 92")
    expect(page.locator("#modal-card")).to_contain_text("剩余真气 2")
    press(page, "#btn-retry")
    press(page, "#btn-toggle-log")
    with page.expect_download() as export:
        page.locator("#btn-export-log").click()
    export_file = Path(export.value.path())
    records = json.loads(export_file.read_text(encoding="utf-8"))
    assert {record.get('endType') for record in records} >= {"ABANDONED", "GAMEOVER"}
    if tmp_path:
        export.value.save_as(tmp_path / "local-playtest.json")
    print("Keyboard, focus, coverage cancellation, failure feedback and JSON export passed")


def reduced_motion(page: Page) -> None:
    page.emulate_media(reduced_motion="reduce")
    reach_zenith(page, "dao_crit")
    add_other_branch(page, "dao_crit")
    press(page, "#btn-run")
    page.clock.run_for(2100)
    expect(page.locator(".modal-score-val")).to_have_text("156")
    assert page.locator(".energy-pulse, .converge-line.active, .screen-shake").count() == 0
    print("Reduced-motion finale passed")


def audio_failure_and_midturn_skip(page: Page) -> None:
    page.evaluate("""() => {
      window.AudioContext = class { constructor() { throw Error('Audio is unavailable'); } };
    }""")
    place(page, "dao_gather", 1)
    place(page, "dao_burst", 3)
    press(page, "#btn-run")
    page.clock.run_for(330)
    press(page, "#btn-skip")
    page.clock.run_for(10)
    expect(page.locator("#burst-total")).to_have_text("43")
    expect(page.locator("#stat-qi")).to_have_text("133")
    assert page.locator(".energy-pulse, .float-notice, .svg-orbit-path.active").count() == 0
    choose_branch(page, "dao_chain")
    print("Unavailable audio still allows mid-turn skip and one correct settlement")


def main() -> None:
    cli = argparse.ArgumentParser()
    cli.add_argument("--url", default="http://127.0.0.1:4177/")
    cli.add_argument("--evidence", type=Path)
    args = cli.parse_args()
    if args.evidence:
        args.evidence.mkdir(parents=True, exist_ok=True)

    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="chrome")
        layout(browser, args.url, args.evidence)
        for scenario in (routes, interruptions, interaction, reduced_motion, audio_failure_and_midturn_skip):
            page = browser.new_page(viewport={"width": 390, "height": 844}, accept_downloads=True)
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.add_init_script("Math.random = () => 0.4")
            page.clock.install()
            response = page.goto(args.url)
            assert response and response.ok
            if scenario in (routes, interaction):
                scenario(page, args.evidence)
            else:
                scenario(page)
            page.close()
        assert not errors, errors
        browser.close()


if __name__ == "__main__":
    main()
