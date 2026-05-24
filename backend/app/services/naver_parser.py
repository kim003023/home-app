import re
import traceback
from playwright.sync_api import sync_playwright


def parse_property_data(url: str) -> dict | None:
    """
    네이버 부동산 인쇄용 URL에서 매물 정보를 파싱합니다.
    반환값: dict (파싱 성공) / None (파싱 실패)
    """
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        try:
            page.goto(url, wait_until="networkidle", timeout=20000)
            page.wait_for_timeout(1500)
            text = page.inner_text("body")

            # ── 매매가 ──────────────────────────────────────
            price_match = re.search(r"매매가\s*([\d,]+)\s*만원", text)
            price = int(price_match.group(1).replace(",", "")) if price_match else 0

            # ── 공급면적 & 전용면적 ──────────────────────────
            # "공급/전용면적 102.34/83.77" 형식
            area_match = re.search(r"공급/전용면적\s*([\d\.]+)/([\d\.]+)", text)
            supply_area   = float(area_match.group(1)) if area_match else 0.0
            exclusive_area = float(area_match.group(2)) if area_match else 0.0

            # ── 동/호 ────────────────────────────────────────
            dong_match = re.search(r"해당동\s*(\d+동)", text)
            dong = dong_match.group(1) if dong_match else None

            ho_match = re.search(r"해당층/총층\s*([^\n]+)", text)
            ho = ho_match.group(1).strip() if ho_match else None

            # ── 세입자 여부 ──────────────────────────────────
            tenant_match = re.search(r"입주가능일\s*([^\n]+)", text)
            has_tenant = True
            if tenant_match and "즉시입주" in tenant_match.group(1):
                has_tenant = False

            direction_match = re.search(r"(남동|남서|북동|북서|남|동|서|북)향", text)
            direction = direction_match.group(0) if direction_match else None

            # ── 대지지분 (자동 파싱 시도) ────────────────────
            land_area = None
            land_match_py = re.search(r"대지지분\s*([\d\.]+)\s*평", text)
            if land_match_py:
                land_area = float(land_match_py.group(1))
            else:
                land_match_m2 = re.search(r"대지지분\s*([\d\.]+)\s*㎡", text)
                if land_match_m2:
                    land_area = round(float(land_match_m2.group(1)) / 3.3058, 2)

            # ── 평면도 이미지 URL ────────────────────────────
            floor_plan_url = None
            try:
                page.wait_for_selector("img", timeout=3000)
                img_elements = page.query_selector_all("img")
                for img in img_elements:
                    src = img.get_attribute("src") or ""
                    alt = img.get_attribute("alt") or ""
                    if "landthumb" in src or "floor" in src.lower() or "평면" in alt or "fplan" in src.lower():
                        floor_plan_url = src
                        if "평면" in alt or "floor" in src.lower() or "fplan" in src.lower():
                            break
            except Exception:
                pass

            return {
                "url": url,
                "price_deposit": price,
                "supply_area": supply_area,
                "exclusive_area": exclusive_area,
                "has_tenant": has_tenant,
                "memo": "",
                "dong": dong,
                "ho": ho,
                "land_area": land_area,
                "floor_plan_url": floor_plan_url,
                "direction": direction,
            }

        except Exception:
            traceback.print_exc()
            return None
        finally:
            browser.close()