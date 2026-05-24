from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlmodel import Session, select
from contextlib import asynccontextmanager
from typing import Optional

from app.db.database import create_db_and_tables, get_session
from app.models.property import PropertyItem
from app.services.naver_parser import parse_property_data


@asynccontextmanager
async def lifespan(app: FastAPI):
    print("서버 시작: 데이터베이스 테이블을 확인/생성합니다.")
    create_db_and_tables()
    yield


app = FastAPI(lifespan=lifespan, title="PropTech Dashboard API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─────────────────────────────────────────────
# Request / Response 모델
# ─────────────────────────────────────────────

class PropertyCreateRequest(BaseModel):
    url: str
    dong: Optional[str] = None
    ho: Optional[str] = None
    land_area: Optional[float] = None          # 대지지분 (평) — 수동 입력 또는 파싱 fallback
    floor_area_ratio: Optional[float] = 181.95  # 현재 용적률 (%)
    lease_deposit: Optional[int] = None         # 전세/보증금 (만원)


class PropertyUpdateRequest(BaseModel):
    dong: Optional[str] = None
    ho: Optional[str] = None
    price_deposit: Optional[int] = None
    lease_deposit: Optional[int] = None
    actual_investment: Optional[int] = None       # 실투자금 (만원) — 사용자 직접 입력
    land_area: Optional[float] = None
    floor_area_ratio: Optional[float] = None
    has_tenant: Optional[bool] = None
    direction: Optional[str] = None               # 향 (남향, 동향 등)
    renovation_status: Optional[str] = None       # 수리상태 (원상/부분수리/올수리)
    memo: Optional[str] = None
    is_modified: Optional[bool] = None


# ─────────────────────────────────────────────
# API 엔드포인트
# ─────────────────────────────────────────────

@app.get("/")
def read_root():
    return {"status": "ok", "message": "PropTech Backend is running!"}


@app.post("/api/properties")
def create_property(request: PropertyCreateRequest, db: Session = Depends(get_session)):
    # 중복 URL 체크
    existing = db.exec(select(PropertyItem).where(PropertyItem.url == request.url)).first()
    if existing:
        raise HTTPException(status_code=400, detail="이미 등록된 매물입니다.")

    # Playwright 파싱
    parsed_data = parse_property_data(request.url)
    if not parsed_data:
        raise HTTPException(status_code=400, detail="매물 정보를 파싱하지 못했습니다. URL을 다시 확인해 주세요.")

    # 대지지분: 파싱 결과 우선, 없으면 수동 입력값 사용
    land_area_final = parsed_data.get("land_area") or request.land_area

    new_property = PropertyItem(
        url=parsed_data["url"],
        price_deposit=parsed_data["price_deposit"],
        supply_area=parsed_data.get("supply_area"),
        exclusive_area=parsed_data["exclusive_area"],
        has_tenant=parsed_data["has_tenant"],
        memo=parsed_data.get("memo", ""),
        dong=parsed_data.get("dong") or request.dong,
        ho=parsed_data.get("ho") or request.ho,
        floor_plan_url=parsed_data.get("floor_plan_url"),
        land_area=land_area_final,
        floor_area_ratio=request.floor_area_ratio,
        lease_deposit=request.lease_deposit,
        direction=parsed_data.get("direction"),
    )
    db.add(new_property)
    db.commit()
    db.refresh(new_property)
    return {"message": "등록 완료", "data": new_property}


@app.get("/api/properties")
def get_properties(db: Session = Depends(get_session)):
    properties = db.exec(select(PropertyItem).order_by(PropertyItem.id.desc())).all()
    return {"data": properties}


@app.put("/api/properties/{property_id}")
def update_property(
    property_id: int,
    request: PropertyUpdateRequest,
    db: Session = Depends(get_session)
):
    prop = db.get(PropertyItem, property_id)
    if not prop:
        raise HTTPException(status_code=404, detail="매물을 찾을 수 없습니다.")

    update_data = request.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(prop, key, value)

    prop.is_modified = True
    db.add(prop)
    db.commit()
    db.refresh(prop)
    return {"message": "수정 완료", "data": prop}


@app.delete("/api/properties/{property_id}")
def delete_property(property_id: int, db: Session = Depends(get_session)):
    prop = db.get(PropertyItem, property_id)
    if not prop:
        raise HTTPException(status_code=404, detail="매물을 찾을 수 없습니다.")
    db.delete(prop)
    db.commit()
    return {"message": "삭제 완료"}