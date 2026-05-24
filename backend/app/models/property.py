from sqlmodel import SQLModel, Field
from typing import Optional
from datetime import datetime, timezone

class PropertyItem(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    url: str = Field(unique=True, index=True, description="네이버 부동산 매물 URL")

    # 위치 정보
    dong: Optional[str] = Field(default=None, description="동 (예: 403동)")
    ho: Optional[str] = Field(default=None, description="층/호수 (예: 4층)")

    # 가격 정보
    price_deposit: Optional[int] = Field(default=None, description="매매가 (단위: 만원)")
    lease_deposit: Optional[int] = Field(default=None, description="전세/보증금 (단위: 만원)")
    actual_investment: Optional[int] = Field(default=None, description="실투자금 (만원) — 사용자 직접 입력")

    # 면적 정보
    supply_area: Optional[float] = Field(default=None, description="공급면적 (㎡)")
    exclusive_area: Optional[float] = Field(default=None, description="전용면적 (㎡)")
    land_area: Optional[float] = Field(default=None, description="대지지분 (평)")
    floor_area_ratio: Optional[float] = Field(default=181.95, description="현재 용적률 (%)")

    # 도면
    floor_plan_url: Optional[str] = Field(default=None, description="평면도 이미지 URL")

    # 임장 체크리스트
    direction: Optional[str] = Field(default=None, description="향 (예: 남향, 동향)")
    renovation_status: Optional[str] = Field(default=None, description="수리상태 (원상/부분수리/올수리)")

    # 상태
    has_tenant: Optional[bool] = Field(default=False, description="세입자 여부 (True: 세입자 있음 / False: 즉시입주)")
    is_modified: bool = Field(default=False, description="수동 수정 여부")
    memo: Optional[str] = Field(default=None, description="임장 메모")

    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))