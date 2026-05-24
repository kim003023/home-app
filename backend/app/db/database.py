import os
from sqlmodel import create_engine, SQLModel, Session

# backend/ 폴더 기준으로 database.db 생성 (로컬 개발용)
BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LOCAL_DB_URL = f"sqlite:///{os.path.join(BASE_DIR, 'database.db')}"

# 환경 변수에 DATABASE_URL이 있으면 (예: Supabase PostgreSQL) 우선 사용, 없으면 로컬 SQLite 사용
DATABASE_URL = os.getenv("DATABASE_URL", LOCAL_DB_URL)

# PostgreSQL일 경우 check_same_thread 인자는 SQLite 전용이므로 제외
connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, connect_args=connect_args, echo=False)

def create_db_and_tables():
    SQLModel.metadata.create_all(engine)

def get_session():
    with Session(engine) as session:
        yield session