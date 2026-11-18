import { useEffect, useRef, useState } from 'react';
import { Check, KeyRound, LoaderCircle } from 'lucide-react';
import { AI_MODELS, clearAIKey, hasAIKey, setAIKey, testAIConnection } from '../services/ai';
import { MAX_BOOK_ANALYSIS_BUDGET_USD } from '../services/book-analysis';
import { AI_PRICING_SOURCE } from '../../supabase/functions/_shared/ai-contract';
import './onboarding.css';

export default function AICredentialsPanel({ online }: { online: boolean }) {
  const keyField = useRef<HTMLInputElement>(null);
  const revision = useRef(0);
  const [checking, setChecking] = useState(false);
  const [keyReady, setKeyReady] = useState(hasAIKey);
  const [connection, setConnection] = useState<{ message: string; error?: boolean }>();
  const [keyError, setKeyError] = useState('');

  useEffect(() => {
    const keyChanged = () => {
      revision.current++;
      setChecking(false);
      setKeyReady(hasAIKey());
      setConnection(undefined);
      setKeyError('');
    };
    window.addEventListener('onr-ai-key-changed', keyChanged);
    return () => { revision.current++; window.removeEventListener('onr-ai-key-changed', keyChanged); };
  }, []);

  async function checkConnection() {
    if (checking || !online || !hasAIKey()) return;
    const ticket = ++revision.current;
    setChecking(true);
    setConnection(undefined);
    try {
      const available = new Set(await testAIConnection());
      const supported = AI_MODELS.filter(model => available.has(model.id));
      if (!supported.length) throw new Error('此密钥当前无法使用阅见支持的模型。请在 DeepSeek 核对账号和模型权限。');
      if (revision.current === ticket) setConnection({ message: `模型查询成功，可用模型 ${supported.map(model => model.name).join('、')}。本次未生成文本。` });
    } catch (failure) {
      if (revision.current === ticket) setConnection({ error: true, message: failure instanceof Error ? failure.message : '暂时无法连接，请稍后重试。' });
    } finally {
      if (revision.current === ticket) setChecking(false);
    }
  }

  return <div className="settings-content ai-setup" aria-labelledby="ai-setup-title">
    <div className="info-note"><KeyRound size={22} aria-hidden="true"/><div><h3 id="ai-setup-title">配置自己的 API Key</h3><p>使用自己的 DeepSeek API Key，无需登录阅见。密钥只留在当前会话内存，刷新或关闭应用后需重新输入。</p></div></div>
    <section className="ai-setup-step" aria-labelledby="ai-setup-key">
      <h3 id="ai-setup-key">会话密钥</h3>
      <p className="muted">在 DeepSeek 开放平台创建 API Key，再粘贴到这里。你可以单独查询可用模型，查询只连接 DeepSeek 模型目录，不发送正文或生成文本。</p>
      <a className="inline-link" href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">在 DeepSeek 管理 API Key ↗</a>
      {!online && <p className="inline-warning">当前离线，恢复网络后即可测试连接。</p>}
      <form autoComplete="off" onSubmit={event => {
        event.preventDefault();
        if (!keyField.current || checking) return;
        try { setAIKey(keyField.current.value); keyField.current.value = ''; }
        catch (failure) { setKeyError(failure instanceof Error ? failure.message : '密钥格式无效。'); }
      }}>
        <label className="form-label">DeepSeek API Key<input ref={keyField} type="password" autoComplete="off" spellCheck={false} autoCapitalize="none"
          maxLength={256} placeholder={keyReady ? '可载入新密钥以替换' : 'sk-…'} required disabled={checking} onInput={() => setKeyError('')}/></label>
        <div className="ai-setup-state" role="status">{keyReady ? <><Check size={16} aria-hidden="true"/>已载入当前会话</> : '尚未载入密钥'}</div>
        {keyError && <p className="inline-error" role="alert">{keyError}</p>}
        <div className="button-row">
          <button className="secondary" type="submit" disabled={checking}>载入密钥</button>
          <button className="secondary" type="button" disabled={!online || !keyReady || checking} onClick={() => void checkConnection()}>
            {checking && <LoaderCircle className="spin" size={16} aria-hidden="true"/>}测试连接（仅查询模型）
          </button>
          <button className="text-button" type="button" disabled={!keyReady || checking} onClick={clearAIKey}>清除密钥</button>
        </div>
      </form>
      {connection && <div className={`auth-message ai-setup-notice ${connection.error ? 'is-error' : ''}`} role={connection.error ? 'alert' : 'status'}>{connection.message}</div>}
    </section>

    <section className="ai-setup-step" aria-labelledby="ai-setup-budget">
      <h3 id="ai-setup-budget">模型与预算</h3>
      <ul className="ai-setup-prices" aria-label="模型估算单价">
        {AI_MODELS.map(model => <li key={model.id}><strong>{model.name}</strong><span>输入 ${model.inputPerMillion.toFixed(2)} · 输出 ${model.outputPerMillion.toFixed(2)}</span></li>)}
      </ul>
      <p className="fine-print">以上为每百万 token 的估算单价，使用高峰且未命中缓存的价格。 <a className="inline-link" href={AI_PRICING_SOURCE} target="_blank" rel="noreferrer">DeepSeek 最新价格 ↗</a></p>
      <p className="muted">在小说的「人物识别」中选择章节、已读范围或整本书。授权前可核对发送范围、模型和费用估算，并设定任务预算。整书任务预算最高 US${MAX_BOOK_ANALYSIS_BUDGET_USD}，实际费用由你的 DeepSeek 账号承担。</p>
      <p className="muted">明确授权分析后，应用才通过 HTTPS 将选定原文和必要上下文直接发送给 DeepSeek。载入密钥、打开章节和查看已保存简介都不会启动付费请求。</p>
    </section>
  </div>;
}
