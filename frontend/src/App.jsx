import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import './App.css';

const API = import.meta.env.VITE_API_URL || 'http://127.0.0.1:10000';

// ─────────────────────────────────────────────────────────
// 유틸 함수
// ─────────────────────────────────────────────────────────

/** 만원 → "X.XX억" 표기 */
function formatPrice(man) {
  if (!man) return '-';
  return (man / 10000).toFixed(2) + '억';
}

/** ㎡ → 평 변환 */
function toPyeong(m2) {
  if (!m2) return 0;
  return m2 / 3.3058;
}

/** 평형 반올림 (공급 기준) */
function pyeongLabel(m2) {
  if (!m2) return null;
  return Math.round(m2 / 3.3058);
}

/** 공급/전용 면적 포맷 표시 */
function formatArea(supplyM2, exclusiveM2) {
  const supplyPy = supplyM2 ? Math.round(toPyeong(supplyM2)) : null;
  const excPy    = exclusiveM2 ? toPyeong(exclusiveM2).toFixed(1) : null;
  if (supplyPy && excPy) {
    return { main: `공급 ${supplyPy}평`, sub: `전용 ${excPy}평` };
  }
  if (excPy) {
    return { main: `전용 ${excPy}평`, sub: null };
  }
  return { main: '-', sub: null };
}

/** 평당가 (만원/평) — 전용면적 기준 */
function perPyeong(price, m2) {
  const py = toPyeong(m2);
  if (!price || !py) return null;
  return Math.round(price / py);
}

/** 원리금 균등상환 월 납부액 계산
 *  principal: 대출원금(만원), yearRate: 연이율(%), years: 기간(년)
 */
function calcMonthlyPayment(principal, yearRate, years) {
  if (!principal || !yearRate || !years) return 0;
  const r = yearRate / 100 / 12;
  const n = years * 12;
  if (r === 0) return principal / n;
  return principal * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
}

/** 재건축 사업성 점수 — 대지지분 절대값 기준
 *  16.0평 기준 80점, ±0.1평당 5점 가감
 *  현재 용적률도 반영: 181.95% 기준, ±1%당 0.5점 가감 (낮을수록 유리)
 */
function redevScore(landArea, farCurrent) {
  if (!landArea || !farCurrent) return null;
  const BASE_LAND = 16.0;
  const BASE_FAR = 181.95;
  const landScore = (landArea - BASE_LAND) * 50;        // 0.1평 차이 = 5점
  const farScore  = (BASE_FAR - farCurrent) * 0.5;      // 용적률 1% 낮을수록 +0.5점
  return Math.min(100, Math.max(0, Math.round(80 + landScore + farScore)));
}

/** 전용면적(㎡)으로 대지지분 기본값 추정 */
function guessLandArea(exclusiveAreaM2) {
  if (!exclusiveAreaM2) return null;
  const py = exclusiveAreaM2 / 3.3058;
  if (py < 25.5) return 16.0;
  if (py < 26.5) return 16.1;
  return null;
}

/** 재건축 분담금 추정 계산
 *  targetAreaM2: 목표 신규 전용면적(㎡), constructionCost: 공사비(만원/㎡)
 *  targetFAR: 목표 용적률(%), currentFAR: 현재 용적률(%)
 */
function calcShareCost(landArea, currentFAR, targetFAR, targetAreaM2, constructionCostPerM2) {
  if (!landArea || !currentFAR || !targetFAR || !targetAreaM2) return null;
  const landM2 = landArea * 3.3058;
  // 무상으로 받는 면적 = 대지지분(㎡) × (목표용적률 / 현재용적률) × 비례율(0.9 가정)
  const freeAreaM2 = landM2 * (targetFAR / currentFAR) * 0.9;
  // 추가 부담 면적
  const extraAreaM2 = Math.max(0, targetAreaM2 - freeAreaM2);
  // 추정 분담금 = 추가면적 × 공사비
  const shareCost = extraAreaM2 * constructionCostPerM2;
  return { freeAreaM2, extraAreaM2, shareCost };
}

/** 
 * 부동산 매수 부대비용 산출 (취득세 + 중개수수료)
 * priceMan: 매매가 (만원)
 * 전용 85㎡ 이하 무주택자 가정 (농특세 비과세, 지방교육세 0.1% 포함)
 */
function calcAcquisitionCost(priceMan) {
  if (!priceMan) return { tax: 0, fee: 0, total: 0 };
  
  // 1. 취득세 (지방교육세 포함)
  let taxRate = 1.1; // 기본 1.1%
  if (priceMan > 60000 && priceMan <= 90000) {
    taxRate = (priceMan * 2 / 30000 - 3) + 0.1;
  } else if (priceMan > 90000) {
    taxRate = 3.3;
  }
  const tax = Math.round(priceMan * (taxRate / 100));

  // 2. 중개수수료 (매매 상한요율)
  let feeRate = 0;
  let maxFee = Infinity;
  if (priceMan < 5000) { feeRate = 0.6; maxFee = 25; }
  else if (priceMan < 20000) { feeRate = 0.5; maxFee = 80; }
  else if (priceMan < 90000) { feeRate = 0.4; }
  else if (priceMan < 120000) { feeRate = 0.5; }
  else if (priceMan < 150000) { feeRate = 0.6; }
  else { feeRate = 0.7; }
  
  let fee = Math.floor(priceMan * (feeRate / 100));
  if (fee > maxFee) fee = maxFee;

  return { tax, fee, total: tax + fee };
}

// 임장 향 옵션
const DIRECTION_OPTIONS = ['남향', '남동향', '남서향', '동향', '서향', '북동향', '북서향', '북향'];
const RENOVATION_OPTIONS = ['원상', '부분수리', '올수리'];

// ─────────────────────────────────────────────────────────
// 1. 매물 리스트 탭
// ─────────────────────────────────────────────────────────

function PropertyList({ properties, onRefresh }) {
  const [url, setUrl] = useState('');
  const [landArea, setLandArea] = useState('');
  const [landAreaHint, setLandAreaHint] = useState(null);
  const [loading, setLoading] = useState(false);
  const [editMemo, setEditMemo] = useState({});
  const [editField, setEditField] = useState({}); // { id: { field: value } }

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!url.trim()) return;
    setLoading(true);
    setLandAreaHint(null);
    try {
      const payload = {
        url: url.trim(),
        land_area: landArea ? parseFloat(landArea) : null,
        floor_area_ratio: 181.95,
      };
      const res = await axios.post(`${API}/api/properties`, payload);
      const saved = res.data.data;

      if (!saved.land_area && saved.exclusive_area) {
        const guessed = guessLandArea(saved.exclusive_area);
        if (guessed) {
          await axios.put(`${API}/api/properties/${saved.id}`, { land_area: guessed });
          setLandAreaHint(
            `💡 대지지분이 자동 파싱되지 않아 전용면적(${saved.exclusive_area}㎡) 기준으로 ${guessed}평을 자동 적용했습니다.`
          );
        }
      }
      setUrl(''); setLandArea('');
      onRefresh();
    } catch (err) {
      const msg = err.response?.data?.detail || err.message || '등록에 실패했습니다.';
      alert(`❌ ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('이 매물을 삭제하시겠습니까?')) return;
    await axios.delete(`${API}/api/properties/${id}`);
    onRefresh();
  };

  const handleMemoSave = async (id, memo) => {
    await axios.put(`${API}/api/properties/${id}`, { memo });
    setEditMemo(prev => { const n = { ...prev }; delete n[id]; return n; });
    onRefresh();
  };

  const handleFieldSave = async (id, field, value) => {
    await axios.put(`${API}/api/properties/${id}`, { [field]: value });
    setEditField(prev => { const n = { ...prev }; delete n[id]; return n; });
    onRefresh();
  };

  return (
    <div>
      {/* ── 등록 폼 ── */}
      <form className="register-form" onSubmit={handleSubmit}>
        <div className="register-form-title">➕ 매물 등록</div>
        <div className="form-row">
          <input
            id="url-input"
            className="form-input"
            type="text"
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="네이버 부동산 인쇄용 URL 붙여넣기 (필수)"
            required
          />
          <div className="form-field">
            <div className="form-label">대지지분 (평)</div>
            <input
              id="land-area-input"
              className="form-input form-input-sm"
              type="number"
              step="0.01"
              value={landArea}
              onChange={e => setLandArea(e.target.value)}
              placeholder="예: 16.1"
            />
          </div>
          <button
            id="register-btn"
            className="btn btn-primary"
            type="submit"
            disabled={loading}
            style={{ alignSelf: 'flex-end' }}
          >
            {loading ? <><span className="spinner" /> 파싱 중...</> : '🔍 매물 등록'}
          </button>
        </div>
        <div style={{ marginTop: '10px', fontSize: '11px', color: 'var(--text-muted)' }}>
          💡 대지지분은 파싱으로 자동 추출됩니다. 실패 시 위 입력칸에 직접 입력하거나, 전용면적 기준으로 자동 적용됩니다 (25평형=16.0평, 26평형=16.1평).
        </div>
        {landAreaHint && (
          <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--accent-green)', background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: 'var(--radius-sm)', padding: '8px 12px' }}>
            {landAreaHint}
          </div>
        )}
      </form>

      {/* ── 매물 테이블 ── */}
      {properties.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">🏘️</div>
          <div className="empty-title">등록된 매물이 없습니다</div>
          <div className="empty-desc">위 폼에 네이버 부동산 인쇄용 URL을 입력하여<br />첫 번째 매물을 등록해 보세요.</div>
        </div>
      ) : (
        <div className="data-table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>동 / 층</th>
                <th>공급 / 전용 면적</th>
                <th>매매가</th>
                <th>대지지분</th>
                <th>평당가</th>
                <th>향</th>
                <th>수리상태</th>
                <th>입주상태</th>
                <th>임장 메모</th>
                <th>관리</th>
              </tr>
            </thead>
            <tbody>
              {properties.map((p, idx) => {
                const area = formatArea(p.supply_area, p.exclusive_area);
                const ppg = perPyeong(p.price_deposit, p.exclusive_area);
                const isEditingMemo = editMemo[p.id] !== undefined;
                const isEditingField = editField[p.id];

                return (
                  <tr key={p.id}>
                    <td className="text-muted" style={{ fontSize: '11px' }}>{properties.length - idx}</td>
                    <td>
                      <span className="font-semibold">{p.dong || '-'}</span>
                      <span className="text-secondary" style={{ marginLeft: 4, fontSize: 12 }}>{p.ho || ''}</span>
                    </td>
                    <td>
                      <span className="font-semibold">{area.main}</span>
                      {area.sub && <div className="price-sub">{area.sub}</div>}
                      {p.supply_area && (
                        <div className="price-sub" style={{ fontSize: 10 }}>
                          {p.supply_area}㎡ / {p.exclusive_area}㎡
                        </div>
                      )}
                    </td>
                    <td>
                      <div className="price-value">{formatPrice(p.price_deposit)}</div>
                    </td>
                    <td>
                      {p.land_area
                        ? <span className="badge badge-blue">{p.land_area}평</span>
                        : <span className="text-muted">-</span>}
                    </td>
                    <td className="font-mono">
                      {ppg ? `${ppg.toLocaleString()}만` : '-'}
                    </td>
                    {/* 향 — 클릭 편집 */}
                    <td>
                      {isEditingField?.field === 'direction' ? (
                        <select
                          className="inline-select"
                          autoFocus
                          defaultValue={p.direction || ''}
                          onBlur={e => handleFieldSave(p.id, 'direction', e.target.value || null)}
                          onChange={e => handleFieldSave(p.id, 'direction', e.target.value || null)}
                        >
                          <option value="">-</option>
                          {DIRECTION_OPTIONS.map(d => <option key={d} value={d}>{d}</option>)}
                        </select>
                      ) : (
                        <span
                          className={`inline-chip ${p.direction ? 'chip-blue' : 'chip-empty'}`}
                          onClick={() => setEditField({ [p.id]: { field: 'direction' } })}
                          title="클릭하여 향 수정"
                        >
                          {p.direction || '미입력'}
                        </span>
                      )}
                    </td>
                    {/* 수리상태 — 클릭 편집 */}
                    <td>
                      {isEditingField?.field === 'renovation_status' ? (
                        <select
                          className="inline-select"
                          autoFocus
                          defaultValue={p.renovation_status || ''}
                          onBlur={e => handleFieldSave(p.id, 'renovation_status', e.target.value || null)}
                          onChange={e => handleFieldSave(p.id, 'renovation_status', e.target.value || null)}
                        >
                          <option value="">-</option>
                          {RENOVATION_OPTIONS.map(r => <option key={r} value={r}>{r}</option>)}
                        </select>
                      ) : (
                        <span
                          className={`inline-chip ${p.renovation_status === '올수리' ? 'chip-green' : p.renovation_status === '부분수리' ? 'chip-orange' : p.renovation_status ? 'chip-muted' : 'chip-empty'}`}
                          onClick={() => setEditField({ [p.id]: { field: 'renovation_status' } })}
                          title="클릭하여 수리상태 수정"
                        >
                          {p.renovation_status || '미입력'}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${p.has_tenant ? 'badge-orange' : 'badge-green'}`}>
                        {p.has_tenant ? '🔑 세입자' : '✅ 즉시입주'}
                      </span>
                    </td>
                    <td>
                      {isEditingMemo ? (
                        <div className="memo-cell">
                          <input
                            className="memo-input"
                            autoFocus
                            defaultValue={editMemo[p.id]}
                            onBlur={e => handleMemoSave(p.id, e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') handleMemoSave(p.id, e.target.value);
                              if (e.key === 'Escape') setEditMemo(prev => { const n = { ...prev }; delete n[p.id]; return n; });
                            }}
                          />
                        </div>
                      ) : (
                        <span
                          className={`memo-text ${!p.memo ? 'empty' : ''}`}
                          onClick={() => setEditMemo(prev => ({ ...prev, [p.id]: p.memo || '' }))}
                          title="클릭하여 메모 편집"
                        >
                          {p.memo || '메모 없음 (클릭 편집)'}
                        </span>
                      )}
                    </td>
                    <td>
                      <button
                        id={`delete-btn-${p.id}`}
                        className="btn btn-danger"
                        onClick={() => handleDelete(p.id)}
                      >
                        삭제
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// 2. 비교 분석 탭
// ─────────────────────────────────────────────────────────

function ComparisonView({ properties, onRefresh, globalBudget }) {
  if (properties.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-icon">📊</div>
        <div className="empty-title">비교할 매물이 없습니다</div>
        <div className="empty-desc">매물 리스트 탭에서 먼저 매물을 등록해 주세요.</div>
      </div>
    );
  }

  // 평형 그룹 분리 (공급면적 기준)
  const groups = {};
  properties.forEach(p => {
    const py = p.supply_area ? Math.round(toPyeong(p.supply_area)) : Math.round(toPyeong(p.exclusive_area));
    const key = `${py}평형 (공급 기준)`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(p);
  });

  const maxPpg = Math.max(...properties.map(p => perPyeong(p.price_deposit, p.exclusive_area) || 0));

  const handleInvestSave = async (id) => {
    const val = investInputs[id];
    if (val === undefined) return;
    await axios.put(`${API}/api/properties/${id}`, { actual_investment: val ? parseInt(val, 10) : null });
    onRefresh();
  };

  // 임장 항목 비교 색상
  const renovColor = (v) => {
    if (v === '올수리') return 'chip-green';
    if (v === '부분수리') return 'chip-orange';
    if (v === '원상') return 'chip-muted';
    return 'chip-empty';
  };

  const budgetVal = globalBudget ? parseInt(globalBudget, 10) : 0;

  return (
    <div>
      {/* ── 전체 가격 막대 차트 ── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header">
          <div className="card-title">📈 매물별 평당가 비교 (전용면적 기준)</div>
        </div>
        <div>
          {[...properties]
            .filter(p => p.price_deposit && p.exclusive_area)
            .sort((a, b) => (perPyeong(a.price_deposit, a.exclusive_area) || 0) - (perPyeong(b.price_deposit, b.exclusive_area) || 0))
            .map(p => {
              const ppg = perPyeong(p.price_deposit, p.exclusive_area) || 0;
              const pct = maxPpg > 0 ? (ppg / maxPpg) * 100 : 0;
              return (
                <div key={p.id} className="bar-item">
                  <div className="bar-item-label">{p.dong} {p.ho}</div>
                  <div className="bar-track">
                    <div className="bar-fill" style={{ width: `${pct}%` }}>
                      {ppg.toLocaleString()}만
                    </div>
                  </div>
                </div>
              );
            })}
        </div>
      </div>

      {/* ── 실투자금 막대 차트 ── */}
      {properties.some(p => p.actual_investment) && (() => {
        const maxInvest = Math.max(...properties.map(p => p.actual_investment || 0));
        return (
          <div className="card" style={{ marginBottom: 20 }}>
            <div className="card-header">
              <div className="card-title">💰 실투자금 비교 (직접 입력 기준)</div>
            </div>
            <div>
              {[...properties]
                .filter(p => p.actual_investment)
                .sort((a, b) => (a.actual_investment || 0) - (b.actual_investment || 0))
                .map(p => {
                  const pct = maxInvest > 0 ? (p.actual_investment / maxInvest) * 100 : 0;
                  return (
                    <div key={p.id} className="bar-item">
                      <div className="bar-item-label">{p.dong} {p.ho}</div>
                      <div className="bar-track">
                        <div className="bar-fill bar-fill-green" style={{ width: `${pct}%` }}>
                          {formatPrice(p.actual_investment)}
                        </div>
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        );
      })()}

      {/* ── 평형별 그룹 테이블 ── */}
      {Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)).map(([groupName, items]) => (
        <div key={groupName} style={{ marginBottom: 24 }}>
          <div className="section-divider">{groupName} ({items.length}개 매물)</div>
          <div className="data-table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>동 / 층</th>
                  <th>공급/전용 평형</th>
                  <th>매매가</th>
                  <th>부대비용</th>
                  <th>총 필요자금</th>
                  <th>필요 대출 (예산 대비)</th>
                  <th>평당가</th>
                  <th>대지지분</th>
                  <th>재건축 점수</th>
                  <th>향</th>
                  <th>수리상태</th>
                  <th>층수</th>
                  <th>입주상태</th>
                </tr>
              </thead>
              <tbody>
                {[...items]
                  .sort((a, b) => (perPyeong(a.price_deposit, a.exclusive_area) || 0) - (perPyeong(b.price_deposit, b.exclusive_area) || 0))
                  .map(p => {
                    const ppg = perPyeong(p.price_deposit, p.exclusive_area);
                    const score = redevScore(p.land_area, p.floor_area_ratio);
                    const area = formatArea(p.supply_area, p.exclusive_area);
                    const cost = calcAcquisitionCost(p.price_deposit);
                    const totalRequired = (p.price_deposit || 0) + cost.total;
                    const loanNeeded = budgetVal > 0 && totalRequired > 0 ? Math.max(0, totalRequired - budgetVal) : null;
                    const surplus = budgetVal > 0 && totalRequired > 0 ? Math.max(0, budgetVal - totalRequired) : null;

                    return (
                      <tr key={p.id}>
                        <td>
                          <span className="font-semibold">{p.dong || '-'}</span>
                          <span className="text-secondary" style={{ marginLeft: 4, fontSize: 12 }}>{p.ho || ''}</span>
                        </td>
                        <td>
                          <span className="font-semibold">{area.main}</span>
                          {area.sub && <div className="price-sub">{area.sub}</div>}
                        </td>
                        <td><div className="price-value">{formatPrice(p.price_deposit)}</div></td>
                        <td>
                          <div className="price-value" style={{ fontSize: 13 }}>{formatPrice(cost.total)}</div>
                          <div className="price-sub" style={{ fontSize: 10 }}>세금 {formatPrice(cost.tax)} / 수수료 {formatPrice(cost.fee)}</div>
                        </td>
                        <td><div className="price-value highlight-blue">{formatPrice(totalRequired)}</div></td>
                        {/* 대출 필요액 (예산 기반) */}
                        <td>
                          {budgetVal === 0 ? (
                            <span className="text-muted" style={{ fontSize: 11 }}>예산 입력 필요</span>
                          ) : loanNeeded > 0 ? (
                            <div>
                              <span className="highlight-orange font-semibold">{formatPrice(loanNeeded)}</span>
                            </div>
                          ) : surplus > 0 ? (
                            <div className="price-sub">
                              <span className="highlight-green font-semibold">예산 {formatPrice(surplus)} 남음</span>
                            </div>
                          ) : (
                            <span className="highlight-green font-semibold">예산 딱 맞음</span>
                          )}
                        </td>
                        <td className="font-mono font-semibold">
                          {ppg ? `${ppg.toLocaleString()}만` : '-'}
                        </td>
                        <td>
                          {p.land_area
                            ? <span className="badge badge-blue">{p.land_area}평</span>
                            : <span className="text-muted">-</span>}
                        </td>
                        <td>
                          {score != null ? (
                            <div className="score-bar-wrap">
                              <div className="score-bar-track">
                                <div className="score-bar-fill" style={{ width: `${score}%` }} />
                              </div>
                              <span className="score-label">{score}</span>
                            </div>
                          ) : (
                            <span className="text-muted" style={{ fontSize: 11 }}>대지지분 필요</span>
                          )}
                        </td>
                        {/* 임장 항목 */}
                        <td>
                          {p.direction
                            ? <span className="inline-chip chip-blue">{p.direction}</span>
                            : <span className="text-muted" style={{ fontSize: 11 }}>-</span>}
                        </td>
                        <td>
                          {p.renovation_status
                            ? <span className={`inline-chip ${renovColor(p.renovation_status)}`}>{p.renovation_status}</span>
                            : <span className="text-muted" style={{ fontSize: 11 }}>-</span>}
                        </td>
                        <td>
                          <span className="text-secondary" style={{ fontSize: 12 }}>{p.ho || '-'}</span>
                        </td>
                        <td>
                          <span className={`badge ${p.has_tenant ? 'badge-orange' : 'badge-green'}`}>
                            {p.has_tenant ? '🔑 세입자' : '✅ 즉시입주'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {/* ── 재건축 분담금 추정 계산기 ── */}
      <RedevShareCalc properties={properties} />

      {/* ── 재건축 사업성 설명 ── */}
      <div className="card" style={{ marginTop: 8 }}>
        <div className="card-title" style={{ marginBottom: 12 }}>ℹ️ 재건축 사업성 점수 산출 방식</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.8 }}>
          <strong>공식</strong>: 대지지분 16.0평 기준 80점, ±0.1평당 ±5점 차등 부여<br />
          현재 용적률 181.95% 기준 0점, 1% 낮을수록 +0.5점 (낮은 용적률 = 사업성 유리)<br />
          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>※ 같은 단지 내 미세 차이를 정밀 비교할 수 있는 상대 점수입니다.</span>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// 재건축 분담금 추정 계산기 컴포넌트
// ─────────────────────────────────────────────────────────

function RedevShareCalc({ properties }) {
  const [showHogok, setShowHogok] = useState(false);
  const [params, setParams] = useState({
    targetFAR: 350,             // 목표 용적률 (%)
    constructionCost: 650,      // 공사비 단가 (만원/㎡)
    targetAreaM2: 59,           // 목표 신규 전용면적 (㎡) — 59㎡ or 84㎡
    entryYear: 2033,            // 예상 입주 연도
  });

  const setParam = (k, v) => setParams(prev => ({ ...prev, [k]: v }));

  const validProps = properties.filter(p => p.land_area && p.floor_area_ratio);

  return (
    <div className="card" style={{ marginTop: 20, marginBottom: 20 }}>
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div className="card-title">🏗️ 재건축 입주 분담금 추정 계산기</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>2032~2034년 입주 기준 대략 추정</div>
        </div>
        <button className="btn btn-outline" onClick={() => setShowHogok(true)} style={{ padding: '6px 12px', fontSize: 13 }}>
          🗺️ 단지 배치도 보기
        </button>
      </div>

      {showHogok && (
        <div className="img-modal-overlay" onClick={() => setShowHogok(false)}>
          <div className="img-modal-content" onClick={e => e.stopPropagation()}>
            <button className="img-modal-close" onClick={() => setShowHogok(false)}>✕</button>
            <img src="/Hogok.jpg" alt="단지 배치도" style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8 }} />
          </div>
        </div>
      )}

      {/* 파라미터 */}
      <div className="share-params-grid">
        <div className="param-group">
          <div className="param-label">목표 용적률 (%)</div>
          <input
            id="share-target-far"
            className="param-input"
            type="number"
            step="10"
            min="200"
            max="500"
            value={params.targetFAR}
            onChange={e => setParam('targetFAR', parseFloat(e.target.value))}
          />
          <div className="param-hint">서울시 2종 재건축 기준 350%</div>
        </div>
        <div className="param-group">
          <div className="param-label">공사비 단가 (만원/㎡)</div>
          <input
            id="share-construction-cost"
            className="param-input"
            type="number"
            step="50"
            min="300"
            max="1500"
            value={params.constructionCost}
            onChange={e => setParam('constructionCost', parseFloat(e.target.value))}
          />
          <div className="param-hint">2025년 서울 기준 600~750만원/㎡</div>
        </div>
        <div className="param-group">
          <div className="param-label">목표 신규 전용면적 (㎡)</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {[59, 74, 84, 114].map(m2 => (
              <button
                key={m2}
                className={`area-chip-btn ${params.targetAreaM2 === m2 ? 'active' : ''}`}
                onClick={() => setParam('targetAreaM2', m2)}
              >
                {m2}㎡<br /><span style={{ fontSize: 9 }}>{Math.round(m2 / 3.3058)}평</span>
              </button>
            ))}
          </div>
          <div className="param-hint">입주 후 받을 새 아파트 전용면적</div>
        </div>
        <div className="param-group">
          <div className="param-label">예상 입주 연도</div>
          <input
            id="share-entry-year"
            className="param-input"
            type="number"
            step="1"
            min="2030"
            max="2040"
            value={params.entryYear}
            onChange={e => setParam('entryYear', parseInt(e.target.value))}
          />
          <div className="param-hint">2032~2034년 예상</div>
        </div>
      </div>

      {/* 결과 테이블 */}
      {validProps.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)', fontSize: 13 }}>
          대지지분이 입력된 매물이 없습니다.
        </div>
      ) : (
        <div className="data-table-wrapper" style={{ marginTop: 16 }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>동 / 층</th>
                <th>대지지분</th>
                <th>현재 용적률</th>
                <th>무상귀속 면적</th>
                <th>추가 부담 면적</th>
                <th>추정 분담금</th>
                <th>매매가 + 분담금</th>
                <th>비고</th>
              </tr>
            </thead>
            <tbody>
              {[...validProps]
                .map(p => {
                  const result = calcShareCost(
                    p.land_area,
                    p.floor_area_ratio,
                    params.targetFAR,
                    params.targetAreaM2,
                    params.constructionCost
                  );
                  return { p, result };
                })
                .sort((a, b) => (a.result?.shareCost || 0) - (b.result?.shareCost || 0))
                .map(({ p, result }) => {
                  if (!result) return null;
                  const { freeAreaM2, extraAreaM2, shareCost } = result;
                  const totalCost = (p.price_deposit || 0) + shareCost;
                  return (
                    <tr key={p.id}>
                      <td>
                        <span className="font-semibold">{p.dong || '-'}</span>
                        <span className="text-secondary" style={{ marginLeft: 4, fontSize: 12 }}>{p.ho || ''}</span>
                      </td>
                      <td><span className="badge badge-blue">{p.land_area}평</span></td>
                      <td><span className="text-secondary">{p.floor_area_ratio}%</span></td>
                      <td>
                        <span className="highlight-green font-semibold">{freeAreaM2.toFixed(1)}㎡</span>
                        <div className="price-sub">≈ {(freeAreaM2 / 3.3058).toFixed(1)}평</div>
                      </td>
                      <td>
                        {extraAreaM2 > 0
                          ? <span className="highlight-orange font-semibold">{extraAreaM2.toFixed(1)}㎡</span>
                          : <span className="highlight-green">0㎡ (무상)</span>}
                      </td>
                      <td>
                        {shareCost > 0
                          ? <div className="price-value highlight-red">{formatPrice(Math.round(shareCost))}</div>
                          : <div className="price-value highlight-green">무상</div>}
                      </td>
                      <td>
                        <div className="price-value">{formatPrice(Math.round(totalCost))}</div>
                        <div className="price-sub">매매가 {formatPrice(p.price_deposit)} + 분담금</div>
                      </td>
                      <td>
                        {extraAreaM2 <= 0
                          ? <span className="badge badge-green">✨ 무상귀속</span>
                          : shareCost < 5000
                          ? <span className="badge badge-blue">👍 소액 분담</span>
                          : <span className="badge badge-orange">⚠️ 분담금 발생</span>}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.8 }}>
        ⚠️ 위 수치는 단순 추정치입니다. 비례율(90% 가정), 공사비, 용적률 등 실제 조합 결의에 따라 크게 달라질 수 있습니다.<br />
        무상귀속 면적 = 대지지분(㎡) × (목표용적률 / 현재용적률) × 비례율 0.9
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// 3. 도면 비교 탭
// ─────────────────────────────────────────────────────────

function FloorPlanView({ properties, globalBudget }) {
  const [selectedA, setSelectedA] = useState('');
  const [selectedB, setSelectedB] = useState('');
  const [modalImg, setModalImg] = useState(null);

  if (properties.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-icon">🗺️</div>
        <div className="empty-title">도면 비교할 매물이 없습니다</div>
        <div className="empty-desc">매물 리스트 탭에서 먼저 매물을 등록해 주세요.</div>
      </div>
    );
  }

  const propA = properties.find(p => String(p.id) === String(selectedA));
  const propB = properties.find(p => String(p.id) === String(selectedB));

  const renderPlanCard = (prop, slot, selected, setSelected) => (
    <div className="floor-plan-card">
      <div className="floor-plan-header">
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
          매물 {slot}
        </div>
        <select
          id={`floor-plan-select-${slot}`}
          className="sim-property-select"
          value={selected}
          onChange={e => setSelected(e.target.value)}
          style={{ marginTop: 8 }}
        >
          <option value="">── 매물 선택 ──</option>
          {properties.map(p => {
            const area = formatArea(p.supply_area, p.exclusive_area);
            return (
              <option key={p.id} value={p.id}>
                {p.dong} {p.ho} | {formatPrice(p.price_deposit)} | {area.main}
              </option>
            );
          })}
        </select>
      </div>

      {prop ? (
        <>
          <div className="floor-plan-meta">
            <span className="badge badge-blue">{formatArea(prop.supply_area, prop.exclusive_area).main}</span>
            {formatArea(prop.supply_area, prop.exclusive_area).sub && (
              <span className="badge badge-blue" style={{ marginLeft: 4 }}>
                {formatArea(prop.supply_area, prop.exclusive_area).sub}
              </span>
            )}
            {prop.direction && <span className="inline-chip chip-blue" style={{ marginLeft: 4 }}>{prop.direction}</span>}
            {prop.renovation_status && (
              <span className={`inline-chip ${prop.renovation_status === '올수리' ? 'chip-green' : prop.renovation_status === '부분수리' ? 'chip-orange' : 'chip-muted'}`} style={{ marginLeft: 4 }}>
                {prop.renovation_status}
              </span>
            )}
          </div>
          {prop.floor_plan_url ? (
            <div
              className="floor-plan-img-wrap"
              onClick={() => setModalImg(prop.floor_plan_url)}
              title="클릭하여 원본 크기로 보기"
            >
              <img
                src={prop.floor_plan_url}
                alt={`${prop.dong} ${prop.ho} 도면`}
                className="floor-plan-img"
                onError={e => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'flex'; }}
              />
              <div className="floor-plan-no-img" style={{ display: 'none' }}>
                <div style={{ fontSize: 32 }}>🖼️</div>
                <div style={{ marginTop: 8 }}>도면 이미지를 불러올 수 없습니다</div>
              </div>
              <div className="floor-plan-zoom-hint">🔍 클릭하여 확대</div>
            </div>
          ) : (
            <div className="floor-plan-no-img">
              <div style={{ fontSize: 48, marginBottom: 12 }}>📐</div>
              <div style={{ fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>도면 미등록</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                파싱 시 평면도가 자동 추출되지 않았습니다.<br />
                네이버 부동산 페이지에서 확인해 주세요.
              </div>
            </div>
          )}
          {/* 매물 정보 요약 */}
          <div className="floor-plan-info-grid">
            <div className="floor-info-item">
              <div className="floor-info-label">매매가</div>
              <div className="floor-info-value highlight-blue">{formatPrice(prop.price_deposit)}</div>
            </div>
            <div className="floor-info-item">
              <div className="floor-info-label">평당가</div>
              <div className="floor-info-value">{perPyeong(prop.price_deposit, prop.exclusive_area) ? `${perPyeong(prop.price_deposit, prop.exclusive_area).toLocaleString()}만` : '-'}</div>
            </div>
            <div className="floor-info-item">
              <div className="floor-info-label">대지지분</div>
              <div className="floor-info-value">{prop.land_area ? `${prop.land_area}평` : '-'}</div>
            </div>
            <div className="floor-info-item">
              <div className="floor-info-label">재건축 점수</div>
              <div className="floor-info-value highlight-blue">
                {redevScore(prop.land_area, prop.floor_area_ratio) ?? '-'}
              </div>
            </div>
            <div className="floor-info-item">
              <div className="floor-info-label">필요 대출액</div>
              <div className="floor-info-value highlight-orange">
                {globalBudget > 0 && prop.price_deposit ? (
                  prop.price_deposit > globalBudget ? formatPrice(prop.price_deposit - globalBudget) : '예산 내 가능'
                ) : '-'}
              </div>
            </div>
            <div className="floor-info-item">
              <div className="floor-info-label">입주</div>
              <div className="floor-info-value">
                {prop.has_tenant ? '🔑 세입자' : '✅ 즉시'}
              </div>
            </div>
          </div>
          {prop.memo && (
            <div className="floor-plan-memo">
              📝 {prop.memo}
            </div>
          )}
        </>
      ) : (
        <div className="floor-plan-no-img" style={{ minHeight: 300 }}>
          <div style={{ fontSize: 48 }}>🏠</div>
          <div style={{ marginTop: 12, color: 'var(--text-muted)' }}>비교할 매물을 선택하세요</div>
        </div>
      )}
    </div>
  );

  return (
    <div>
      <div className="floor-plan-layout">
        {renderPlanCard(propA, 'A', selectedA, setSelectedA)}
        <div className="floor-plan-divider">VS</div>
        {renderPlanCard(propB, 'B', selectedB, setSelectedB)}
      </div>

      {/* 이미지 모달 */}
      {modalImg && (
        <div className="img-modal-overlay" onClick={() => setModalImg(null)}>
          <div className="img-modal-content" onClick={e => e.stopPropagation()}>
            <button className="img-modal-close" onClick={() => setModalImg(null)}>✕</button>
            <img src={modalImg} alt="도면 원본" style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8 }} />
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// 4. 10년 시뮬레이터 탭
// ─────────────────────────────────────────────────────────

function SimulatorView({ properties, globalBudget }) {
  const [params, setParams] = useState({
    loanRate: 3.5,
    ltv: 70,
    holdYears: 10,
    annualRise: 3.0,
  });
  const [selectedA, setSelectedA] = useState('');
  const [selectedB, setSelectedB] = useState('');
  const [showSchedule, setShowSchedule] = useState(false);

  const setParam = (key, val) => setParams(prev => ({ ...prev, [key]: val }));

  const calcResult = (propId) => {
    if (!propId) return null;
    const p = properties.find(x => String(x.id) === String(propId));
    if (!p || !p.price_deposit) return null;

    const price = p.price_deposit;
    const cost = calcAcquisitionCost(price);
    const totalRequired = price + cost.total;
    const budgetVal = globalBudget ? parseInt(globalBudget, 10) : 0;
    
    // 예산이 입력되어 있으면 (총필요자금 - 예산)을 대출금으로 계산. 
    // 예산이 없으면 LTV 기준으로 대출금 계산
    const loanAmount = budgetVal > 0 
      ? Math.max(0, totalRequired - budgetVal) 
      : Math.round(totalRequired * params.ltv / 100);
      
    const realInvestLoan = totalRequired - loanAmount;

    const monthlyPayment = calcMonthlyPayment(loanAmount, params.loanRate, params.holdYears);
    const totalInterest = monthlyPayment * 12 * params.holdYears - loanAmount;

    const futurePrice = price * Math.pow(1 + params.annualRise / 100, params.holdYears);
    const capitalGain = futurePrice - price;
    const netProfit = capitalGain - totalInterest;
    const score = redevScore(p.land_area, p.floor_area_ratio);

    // 월별 스케줄 생성
    const schedule = [];
    let balance = loanAmount;
    const r = params.loanRate / 100 / 12;
    let accumPrincipal = 0;
    
    for(let i = 1; i <= params.holdYears * 12; i++) {
      const interest = balance * r;
      const principal = monthlyPayment - interest;
      accumPrincipal += principal;
      balance -= principal;
      if (balance < 0) balance = 0;
      schedule.push({ month: i, interest, principal, accumPrincipal, balance, payment: monthlyPayment });
    }

    return { p, price, cost, totalRequired, realInvestLoan, loanAmount, monthlyPayment, totalInterest, futurePrice, capitalGain, netProfit, score, schedule };
  };

  const resultA = calcResult(selectedA);
  const resultB = calcResult(selectedB);

  const renderCard = (result, slot) => {
    if (!result) {
      return (
        <div className="sim-card">
          <div className="sim-card-header">
            <div className="sim-property-name">매물 {slot}</div>
          </div>
          <select
            id={`sim-select-${slot}`}
            className="sim-property-select"
            value={slot === 'A' ? selectedA : selectedB}
            onChange={e => slot === 'A' ? setSelectedA(e.target.value) : setSelectedB(e.target.value)}
          >
            <option value="">── 매물 선택 ──</option>
            {properties.map(p => {
              const area = formatArea(p.supply_area, p.exclusive_area);
              return (
                <option key={p.id} value={p.id}>
                  {p.dong} {p.ho} | {formatPrice(p.price_deposit)} | {area.main}
                </option>
              );
            })}
          </select>
          <div className="sim-no-select">🏠 비교할 매물을 선택하세요</div>
        </div>
      );
    }

    const { p, cost, totalRequired, realInvestLoan, loanAmount, monthlyPayment, totalInterest, futurePrice, capitalGain, netProfit, score } = result;
    const area = formatArea(p.supply_area, p.exclusive_area);

    return (
      <div className="sim-card">
        <div className="sim-card-header">
          <div>
            <div className="sim-property-name">{p.dong} {p.ho}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              {area.main} {area.sub ? `/ ${area.sub}` : ''} | {p.has_tenant ? '세입자 있음' : '즉시입주'}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <span className={`badge ${p.has_tenant ? 'badge-orange' : 'badge-green'}`}>
              {p.has_tenant ? '🔑 갭투자' : '✅ 실거주'}
            </span>
          </div>
        </div>

        <select
          id={`sim-select-${slot}`}
          className="sim-property-select"
          value={slot === 'A' ? selectedA : selectedB}
          onChange={e => slot === 'A' ? setSelectedA(e.target.value) : setSelectedB(e.target.value)}
        >
          <option value="">── 매물 선택 ──</option>
          {properties.map(px => {
            const a = formatArea(px.supply_area, px.exclusive_area);
            return (
              <option key={px.id} value={px.id}>
                {px.dong} {px.ho} | {formatPrice(px.price_deposit)} | {a.main}
              </option>
            );
          })}
        </select>

        <div className="sim-metrics-grid">
          <div className="sim-metric">
            <div className="sim-metric-label">매매가</div>
            <div className="sim-metric-value highlight-blue">{formatPrice(p.price_deposit)}</div>
          </div>
          <div className="sim-metric">
            <div className="sim-metric-label">부대비용 (취득세+수수료)</div>
            <div className="sim-metric-value highlight-orange">{formatPrice(cost.total)}</div>
            <div className="sim-metric-sub">총 필요자금 {formatPrice(totalRequired)}</div>
          </div>
          <div className="sim-metric">
            <div className="sim-metric-label">{globalBudget > 0 ? '필요 대출 (예산 초과분)' : `필요 대출금 (${params.ltv}%)`}</div>
            <div className="sim-metric-value highlight-red">{formatPrice(loanAmount)}</div>
            <div className="sim-metric-sub">{globalBudget > 0 ? `총 자금 - 예산 ${formatPrice(globalBudget)}` : `실투자금 ${formatPrice(realInvestLoan)}`}</div>
          </div>
          <div className="sim-metric">
            <div className="sim-metric-label">월 원리금 상환</div>
            <div className="sim-metric-value highlight-orange">{Math.round(monthlyPayment).toLocaleString()}만</div>
            <div className="sim-metric-sub">연이율 {params.loanRate}% / {params.holdYears}년</div>
          </div>
          <div className="sim-metric">
            <div className="sim-metric-label">{params.holdYears}년 총 이자</div>
            <div className="sim-metric-value highlight-red">{formatPrice(Math.round(totalInterest))}</div>
          </div>
          <div className="sim-metric">
            <div className="sim-metric-label">{params.holdYears}년 후 예상 시세</div>
            <div className="sim-metric-value highlight-blue">{formatPrice(Math.round(futurePrice))}</div>
            <div className="sim-metric-sub">연 {params.annualRise}% 상승 가정</div>
          </div>
          <div className="sim-metric">
            <div className="sim-metric-label">예상 시세차익</div>
            <div className={`sim-metric-value ${capitalGain > 0 ? 'highlight-green' : 'highlight-red'}`}>
              {capitalGain >= 0 ? '+' : ''}{formatPrice(Math.round(capitalGain))}
            </div>
          </div>
          <div className="sim-metric" style={{ gridColumn: '1 / -1' }}>
            <div className="sim-metric-label">순수익 (시세차익 - 이자비용)</div>
            <div className={`sim-metric-value ${netProfit > 0 ? 'highlight-green' : 'highlight-red'}`} style={{ fontSize: 24 }}>
              {netProfit >= 0 ? '+' : ''}{formatPrice(Math.round(netProfit))}
            </div>
            <div className="sim-metric-sub">
              {netProfit > 0 ? '✅ 이자를 제하고도 수익 예상' : '⚠️ 이자가 시세차익을 초과할 수 있음'}
            </div>
          </div>
        </div>

        {score != null && (
          <div style={{ marginTop: 4, padding: '12px', background: 'var(--bg-surface)', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.4px' }}>
              재건축 사업성 점수
            </div>
            <div className="score-bar-wrap">
              <div className="score-bar-track" style={{ height: 10 }}>
                <div className="score-bar-fill" style={{ width: `${score}%` }} />
              </div>
              <span className="score-label" style={{ fontSize: 16, minWidth: 40 }}>{score}</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              대지지분 {p.land_area}평 / 현재 용적률 {p.floor_area_ratio}%
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
      <div className="simulator-layout">
        <div className="simulator-params">
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>
            ⚙️ 시뮬레이션 파라미터
          </div>
          <div className="sim-divider" />

          <div className="param-group">
            <div className="param-label">연 대출 금리 (%)</div>
            <input id="param-loan-rate" className="param-input" type="number" step="0.1" min="0" max="30" value={params.loanRate} onChange={e => setParam('loanRate', parseFloat(e.target.value))} />
            <div className="param-hint">현재 시중 금리 기준: 3~4%대</div>
          </div>
          <div className="param-group">
            <div className="param-label">LTV (주택담보대출비율 %)</div>
            <input 
              id="param-ltv" 
              className="param-input" 
              type="number" step="5" min="0" max="100" 
              value={params.ltv} 
              onChange={e => setParam('ltv', parseFloat(e.target.value))} 
              disabled={globalBudget > 0}
            />
            <div className="param-hint">
              {globalBudget > 0 ? '가용 예산 우선 적용됨' : '일반적으로 60~70%'}
            </div>
          </div>
          <div className="param-group">
            <div className="param-label">보유 기간 (년)</div>
            <input id="param-hold-years" className="param-input" type="number" step="1" min="1" max="30" value={params.holdYears} onChange={e => setParam('holdYears', parseInt(e.target.value))} />
          </div>
          <div className="param-group">
            <div className="param-label">연 시세 상승률 (%)</div>
            <input id="param-annual-rise" className="param-input" type="number" step="0.5" min="0" max="30" value={params.annualRise} onChange={e => setParam('annualRise', parseFloat(e.target.value))} />
            <div className="param-hint">보수적: 2%, 적정: 3%, 낙관적: 5%</div>
          </div>

          <div className="sim-divider" />
          <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.8 }}>
            ⚠️ 시뮬레이션은 단순화된 모델입니다.<br />
            세금(취득세·양도세), 중개수수료, 수선비 등은 포함되지 않습니다.
          </div>
        </div>

        {properties.length === 0 ? (
          <div className="empty-state" style={{ flex: 1 }}>
            <div className="empty-icon">🔢</div>
            <div className="empty-title">매물이 없습니다</div>
            <div className="empty-desc">매물 리스트 탭에서 먼저 매물을 등록해 주세요.</div>
          </div>
        ) : (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div className="sim-results-grid">
              {renderCard(resultA, 'A')}
              {renderCard(resultB, 'B')}
            </div>

            {/* 월별 스케줄 테이블 */}
            {(resultA || resultB) && (
              <div className="card">
                <div className="card-header" style={{ marginBottom: 12 }}>
                  <div className="card-title">📅 월별 원리금 상환 스케줄 (첫 12개월 및 마지막 12개월 요약)</div>
                  <button className="btn btn-ghost" onClick={() => setShowSchedule(!showSchedule)} style={{ padding: '6px 12px', fontSize: 12 }}>
                    {showSchedule ? '스케줄 숨기기' : '상세 스케줄 보기'}
                  </button>
                </div>
                
                {showSchedule && (
                  <>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'right', marginBottom: 4 }}>
                      👉 표를 가로로 스와이프하여 넘겨보세요
                    </div>
                    <div className="data-table-wrapper" style={{ maxHeight: 400, overflowY: 'auto', overflowX: 'auto' }}>
                    <table className="data-table">
                      <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                        <tr>
                          <th>월차</th>
                          <th>매물 A 원금상환</th>
                          <th>매물 A 이자</th>
                          <th>매물 A 잔여원금</th>
                          <th style={{ borderLeft: '2px solid var(--border)' }}>매물 B 원금상환</th>
                          <th>매물 B 이자</th>
                          <th>매물 B 잔여원금</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Array.from({ length: params.holdYears * 12 }).map((_, i) => {
                          // 첫 1년과 마지막 1년만 보여주기 (너무 길면 자르기)
                          const totalMonths = params.holdYears * 12;
                          if (i >= 12 && i < totalMonths - 12) {
                            if (i === 12) {
                              return (
                                <tr key="ellipsis">
                                  <td colSpan="7" style={{ textAlign: 'center', color: 'var(--text-muted)' }}>... 중간 생략 ...</td>
                                </tr>
                              );
                            }
                            return null;
                          }

                          const a = resultA?.schedule[i];
                          const b = resultB?.schedule[i];
                          return (
                            <tr key={i}>
                              <td className="font-semibold">{i + 1}개월차</td>
                              {a ? (
                                <>
                                  <td className="text-green">{Math.round(a.principal).toLocaleString()}만</td>
                                  <td className="text-orange">{Math.round(a.interest).toLocaleString()}만</td>
                                  <td className="font-mono">{formatPrice(Math.round(a.balance))}</td>
                                </>
                              ) : <td colSpan="3" className="text-muted text-center">-</td>}
                              
                              {b ? (
                                <>
                                  <td className="text-green" style={{ borderLeft: '2px solid var(--border)' }}>{Math.round(b.principal).toLocaleString()}만</td>
                                  <td className="text-orange">{Math.round(b.interest).toLocaleString()}만</td>
                                  <td className="font-mono">{formatPrice(Math.round(b.balance))}</td>
                                </>
                              ) : <td colSpan="3" className="text-muted text-center" style={{ borderLeft: '2px solid var(--border)' }}>-</td>}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// 최상위 App 컴포넌트
// ─────────────────────────────────────────────────────────

const TABS = [
  { id: 'list',      icon: '🏘️', label: '매물 리스트' },
  { id: 'compare',   icon: '📊', label: '비교 분석' },
  { id: 'floorplan', icon: '🗺️', label: '도면 비교' },
  { id: 'sim',       icon: '🔢', label: '10년 시뮬레이터' },
];

export default function App() {
  // 모바일 화면이면 초기 탭을 compare로, PC면 list로 설정
  const isMobile = typeof window !== 'undefined' && window.innerWidth <= 768;
  const [activeTab, setActiveTab] = useState(isMobile ? 'compare' : 'list');
  const [properties, setProperties] = useState([]);
  const [globalBudget, setGlobalBudget] = useState('');

  const fetchProperties = useCallback(async () => {
    try {
      const res = await axios.get(`${API}/api/properties`);
      setProperties(res.data.data);
    } catch (err) {
      console.error('매물 조회 실패:', err);
    }
  }, []);

  useEffect(() => { fetchProperties(); }, [fetchProperties]);

  return (
    <div className="app-wrapper">
      <header className="app-header">
        <div className="header-brand">
          <div className="header-logo">🏠</div>
          <div>
            <div className="header-title">후곡마을 4단지 PropTech</div>
            <div className="header-subtitle">25평·26평 투자 분석 대시보드</div>
          </div>
        </div>

        <nav className="nav-tabs" role="navigation" aria-label="메인 탭">
          {TABS.map(tab => (
            <button
              key={tab.id}
              id={`tab-${tab.id}`}
              className={`nav-tab ${activeTab === tab.id ? 'active' : ''} ${tab.id === 'list' ? 'hide-on-mobile' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <span className="nav-tab-icon">{tab.icon}</span>
              <span className="nav-tab-text">{tab.label}</span>
            </button>
          ))}
        </nav>

        <div className="header-controls" style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-surface)', padding: '6px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>💰 가용 예산</span>
            <input
              className="form-input budget-input"
              type="number"
              placeholder="예: 30000"
              value={globalBudget}
              onChange={e => setGlobalBudget(e.target.value)}
              style={{ width: 100, padding: '4px 8px', fontSize: 13 }}
            />
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>만원</span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            총 {properties.length}개 매물
          </div>
        </div>
      </header>

      <main className="page-content">
        {activeTab === 'list' && (
          <PropertyList properties={properties} onRefresh={fetchProperties} />
        )}
        {activeTab === 'compare' && (
          <ComparisonView properties={properties} onRefresh={fetchProperties} globalBudget={globalBudget} />
        )}
        {activeTab === 'floorplan' && (
          <FloorPlanView properties={properties} globalBudget={globalBudget} />
        )}
        {activeTab === 'sim' && (
          <SimulatorView properties={properties} globalBudget={globalBudget} />
        )}
      </main>
    </div>
  );
}