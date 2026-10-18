import { auth, authApi, watchResidence, syncResidenceState, deleteResidenceRecords, writeResidenceRecord, saveResidenceConfiguration } from "./firebase.js";
(() => {
  "use strict";
  const STORAGE_KEY = "controleAguaPwa.v1";
  const $ = id => document.getElementById(id);
  const now = new Date();
  const localDate = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  const localTime = d => `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
  const money = cents => (cents / 100).toLocaleString("pt-BR",{style:"currency",currency:"BRL"});
  const number = n => Math.round(n).toLocaleString("pt-BR");
  const stamp = x => `${x.date}T${x.time || "00:00"}`;
  const dateTimeLabel = (date,time) => { if(!date)return "Data não informada"; const [y,m,d]=date.split("-"); return `${d}/${m}/${y}${time?" • "+time:""}`; };
  const centsFromInput = value => {
    const digits = String(value ?? "").replace(/\D/g, "");
    return digits ? Number(digits) : 0;
  };
  const formatCentsInput = value => {
    const digits = String(value ?? "").replace(/\D/g, "");
    const cents = digits ? Number(digits) : 0;
    return (cents / 100).toLocaleString("pt-BR", {minimumFractionDigits: 2, maximumFractionDigits: 2});
  };
  function attachMoneyMask(input) {
    if (!input || input.dataset.moneyMask === "true") return;
    input.dataset.moneyMask = "true";
    input.addEventListener("input", () => {
      const before = input.value;
      const cursorFromEnd = before.length - (input.selectionStart ?? before.length);
      input.value = formatCentsInput(before);
      const pos = Math.max(0, input.value.length - cursorFromEnd);
      try { input.setSelectionRange(pos, pos); } catch (_) {}
    });
    input.addEventListener("focus", () => { if (!input.value) input.value = "0,00"; });
    input.addEventListener("blur", () => { if (!input.value) input.value = "0,00"; });
  }
  const makeId = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const defaultState = () => ({version:2,residence:{id:"residencia-local",name:"Minha residência",capacityLiters:5000,alertLiters:1000,referencePriceCents:25000,initialSetupDone:false},measurements:[],supplies:[],transfers:[],audit:[]});
  let state=loadState(), activeFilter="todos", toastTimer;
  let currentUser=null, cloudReady=false, cloudUnsubscribe=null, authMode="login", cloudWriteTimer=null, handlingCloudUpdate=false;
  function loadState(){
    try { const raw=localStorage.getItem(STORAGE_KEY); if(raw){const s=JSON.parse(raw); if(s&&s.residence){s.measurements=s.measurements||[];s.supplies=s.supplies||[];s.transfers=s.transfers||[];s.audit=s.audit||[];s.measurements.forEach(m=>m.tank=m.tank||"cisterna");return s;}}}catch(e){}
    return defaultState();
  }
  function saveState(){
    localStorage.setItem(STORAGE_KEY,JSON.stringify(state));
    renderAll();
    // Os registros são gravados individualmente no Firestore antes de confirmar o sucesso.
    // Não sincronizar o estado inteiro aqui: snapshots remotos poderiam sobrescrever
    // uma alteração local ainda pendente e causar perda silenciosa do novo registro.
  }
  function friendlyError(error){
    const code=error?.code||"";
    if(code.includes("auth/invalid-credential"))return "E-mail ou senha incorretos.";
    if(code.includes("auth/email-already-in-use"))return "Este e-mail já possui uma conta.";
    if(code.includes("auth/weak-password"))return "A senha deve ter pelo menos 6 caracteres.";
    if(code.includes("auth/invalid-email"))return "O e-mail informado não é válido.";
    if(code.includes("permission-denied")||code.includes("firestore/permission-denied"))return "Conta autenticada, mas sem permissão na residência. Confira as regras e o cadastro de membro no Firestore.";
    if(code.includes("network"))return "Sem conexão com a internet. Verifique a rede e tente novamente.";
    return error?.message||"Ocorreu um erro inesperado.";
  }
  function setAuthMessage(message){$("authMessage").textContent=message;}
  function setAppVisible(visible){
    $("authScreen").hidden=visible;
    $("membershipScreen").hidden=true;
    $("appMain").hidden=!visible;
    document.querySelector(".topbar").hidden=!visible;
    document.querySelector(".bottom-nav").hidden=!visible;
  }
  function mergeCloudData(remote, isMissingConfig){
    handlingCloudUpdate=true;
    if(remote.config){
      state.residence.name=remote.config.name||state.residence.name;
      state.residence.capacityLiters=Number(remote.config.capacityLiters)||state.residence.capacityLiters;
      state.residence.alertLiters=Number.isFinite(Number(remote.config.alertLiters))?Number(remote.config.alertLiters):state.residence.alertLiters;
      state.residence.referencePriceCents=Number(remote.config.referencePriceCents)||state.residence.referencePriceCents;
      state.residence.initialSetupDone=!!remote.config.initialSetupDone;
    }
    // O Firestore é a fonte oficial após a conexão: nunca mesclar dados locais antigos
    // automaticamente, pois isso recriaria registros de teste apagados no servidor.
    state.supplies = [...(remote.supplies || [])];
    state.transfers = [...(remote.transfers || [])];
    state.measurements = [...(remote.measurements || [])];
    state.audit = [...(remote.audit || [])];
    localStorage.setItem(STORAGE_KEY,JSON.stringify(state));
    renderAll();
    handlingCloudUpdate=false;
    cloudReady=true;
    if(isMissingConfig)syncResidenceState({...state, supplies:[], transfers:[], measurements:[], audit:[]}).catch(err=>showToast("Não foi possível inicializar os dados compartilhados: "+friendlyError(err)));
  }
  function startResidenceSync(user){
    if(cloudUnsubscribe)cloudUnsubscribe();
    cloudReady=false;
    let firstReady=false;
    cloudUnsubscribe=watchResidence(
      (remote)=>mergeCloudData(remote,false),
      (error)=>{
        cloudReady=false;
        $("membershipScreen").hidden=false;$("authScreen").hidden=true;
        $("appMain").hidden=true;document.querySelector(".topbar").hidden=true;document.querySelector(".bottom-nav").hidden=true;
        $("membershipMessage").textContent=friendlyError(error);
      },
      (configMissing)=>{
        if(firstReady)return;
        firstReady=true;
        cloudReady=true;
        if(configMissing) syncResidenceState({...state, supplies:[], transfers:[], measurements:[], audit:[]}).catch(err=>showToast("Erro ao inicializar a residência: "+friendlyError(err)));
        $("membershipScreen").hidden=true;
        setAppVisible(true);
        $("signedInAs").textContent=`Conectado como ${user.displayName||user.email||"usuário"}`;
      }
    );
  }
  authApi.onAuthStateChanged(auth,user=>{
    currentUser=user;
    cloudReady=false;
    if(!user){
      if(cloudUnsubscribe){cloudUnsubscribe();cloudUnsubscribe=null;}
      setAppVisible(false);
      $("authScreen").hidden=false;
      $("membershipScreen").hidden=true;
      return;
    }
    $("authScreen").hidden=true;
    $("appMain").hidden=true;
    document.querySelector(".topbar").hidden=true;
    document.querySelector(".bottom-nav").hidden=true;
    startResidenceSync(user);
  });
  $("authForm").addEventListener("submit",async e=>{
    e.preventDefault();
    const email=$("authEmail").value.trim(),password=$("authPassword").value;
    $("authSubmit").disabled=true;setAuthMessage("Aguarde...");
    try{
      if(authMode==="signup"){
        const cred=await authApi.createUserWithEmailAndPassword(auth,email,password);
        const displayName=$("authName").value.trim();
        if(displayName)await authApi.updateProfile(cred.user,{displayName});
        setAuthMessage("Conta criada. Ela precisa ser vinculada à residência pelo responsável no Firestore.");
      }else{
        await authApi.signInWithEmailAndPassword(auth,email,password);
        setAuthMessage("");
      }
    }catch(error){setAuthMessage(friendlyError(error));}
    finally{$("authSubmit").disabled=false;}
  });
  $("toggleAuthMode").addEventListener("click",()=>{
    authMode=authMode==="login"?"signup":"login";
    $("authTitle").textContent=authMode==="login"?"Entrar no Controle de Água":"Criar conta";
    $("authSubmit").textContent=authMode==="login"?"Entrar":"Criar conta";
    $("toggleAuthMode").textContent=authMode==="login"?"Criar uma conta":"Já tenho uma conta";
    $("authNameWrap").hidden=authMode!=="signup";
    $("authPassword").autocomplete=authMode==="login"?"current-password":"new-password";
    setAuthMessage("");
  });
  $("resetPassword").addEventListener("click",async()=>{
    const email=$("authEmail").value.trim();
    if(!email){setAuthMessage("Informe seu e-mail para receber o link de redefinição.");return;}
    try{await authApi.sendPasswordResetEmail(auth,email);setAuthMessage("Se a conta existir, o e-mail de redefinição será enviado.");}
    catch(error){setAuthMessage(friendlyError(error));}
  });
  $("signOutButton").addEventListener("click",()=>authApi.signOut(auth));
  $("signOutUnauthorized").addEventListener("click",()=>authApi.signOut(auth));
  function recordAudit(action,recordId,description){state.audit.push({id:makeId(),action,recordId,description,createdAt:new Date().toISOString()});}
  function upsertById(list, record){
    const index=list.findIndex(item=>item.id===record.id);
    if(index>=0) list[index]={...list[index],...record}; else list.push(record);
  }
  async function persistNewRecord(collectionName, stateKey, record, auditDescription){
    if(!currentUser || !cloudReady) throw new Error("A conexão com a residência ainda não está pronta. Aguarde alguns segundos e tente novamente.");
    const audit={id:makeId(),action:"criado",recordId:record.id,description:auditDescription,createdAt:new Date().toISOString()};
    await writeResidenceRecord(collectionName,record);
    await writeResidenceRecord("audit",audit);
    upsertById(state[stateKey],record);
    upsertById(state.audit,audit);
    localStorage.setItem(STORAGE_KEY,JSON.stringify(state));
    renderAll();
  }

  function eventsFor(tank){
    const list=[];
    state.measurements.filter(m=>(m.tank||"cisterna")===tank).forEach(x=>list.push({...x,kind:"medicao",at:stamp(x)}));
    if(tank==="cisterna"){
      state.supplies.filter(x=>x.liters!==null&&x.liters!==undefined).forEach(x=>list.push({...x,kind:"entrada",at:stamp(x)}));
      state.transfers.forEach(x=>list.push({...x,kind:"saida",at:stamp(x)}));
    }
    return list.sort((a,b)=>a.at.localeCompare(b.at));
  }
  // Saldo atual baseado na medição mais recentemente registrada e nos movimentos
  // registrados depois dela. Transferências recém-salvas sempre reduzem a cisterna.
  function estimateAt(tank,at=null){
    if(tank!=="cisterna") return null;
    const measures=state.measurements.filter(m=>(m.tank||"cisterna")==="cisterna")
      .filter(m=>!at||stamp(m)<=at)
      .sort((a,b)=>(a.createdAt||stamp(a)).localeCompare(b.createdAt||stamp(b)));
    const anchor=measures[measures.length-1];
    if(!anchor) return null;
    let volume=Number(anchor.liters);
    const anchorCreated=anchor.createdAt||stamp(anchor);
    const movements=[
      ...state.supplies.filter(x=>x.liters!==null&&x.liters!==undefined).map(x=>({...x,kind:"entrada"})),
      ...state.transfers.map(x=>({...x,kind:"saida"}))
    ].filter(x=>(x.createdAt||stamp(x))>anchorCreated)
     .filter(x=>!at||stamp(x)<=at)
     .sort((a,b)=>(a.createdAt||stamp(a)).localeCompare(b.createdAt||stamp(b)));
    for(const movement of movements) volume += movement.kind==="entrada" ? Number(movement.liters) : -Number(movement.liters);
    return volume;
  }
  function latestMeasurement(tank){
    return state.measurements.filter(m=>(m.tank||"cisterna")===tank)
      .sort((a,b)=>(a.createdAt||stamp(a)).localeCompare(b.createdAt||stamp(b))).slice(-1)[0]||null;
  }
  // Consumo residencial é representado pela água transferida da cisterna para a caixa.
  // A média usa a data/hora dos eventos, inclusive em registros retroativos.
  function calculateConsumption(){
    const transfers=state.transfers
      .filter(x=>Number.isFinite(Number(x.liters))&&Number(x.liters)>0&&stamp(x))
      .slice().sort((a,b)=>stamp(a).localeCompare(stamp(b)));
    if(transfers.length<2)return null;
    const first=stamp(transfers[0]);
    const last=stamp(transfers[transfers.length-1]);
    const elapsedDays=(new Date(last)-new Date(first))/86400000;
    if(!Number.isFinite(elapsedDays)||elapsedDays<=0)return null;
    const totalLiters=transfers.reduce((sum,x)=>sum+Number(x.liters),0);
    return totalLiters/elapsedDays;
  }

  function currentMonthKey(){return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;}
  function setDefaultDateFields(){["supply","transfer","measurement"].forEach(p=>{if($(p+"Date")&&!$(p+"Date").value)$(p+"Date").value=localDate(now);if($(p+"Time")&&!$(p+"Time").value)$(p+"Time").value=localTime(now);});if(!$('reportMonth').value)$('reportMonth').value=currentMonthKey();}
  function showView(name){document.querySelectorAll(".view").forEach(v=>v.classList.toggle("active",v.id===`view-${name}`));document.querySelectorAll(".nav-item").forEach(b=>b.classList.toggle("active",b.dataset.view===name));if(name==="settings")fillSettings();if(["supply","transfer","measurement"].includes(name))setDefaultDateFields();if(name==="reports")renderReports();if(name==="transfer"){$("transferLiters").value=$("transferLiters").value||"1000";updateTransferHint();}$("appMain").scrollTo({top:0,behavior:"smooth"});}
  function showToast(message){const el=$("toast");el.textContent=message;el.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove("show"),3000);}
  function renderDashboard(){
    const cistern=estimateAt("cisterna"),r=state.residence,cm=latestMeasurement("cisterna");
    $("residenceLabel").textContent=r.name;
    $("currentVolume").textContent=cistern===null?"—":number(cistern);
    $("capacityText").textContent=`de ${number(r.capacityLiters)} L`;
    const pct=cistern===null?0:Math.max(0,Math.min(100,cistern/r.capacityLiters*100));
    $("percentText").textContent=cistern===null?"Sem medição":`${Math.round(pct)}%`;
    $("levelBar").style.width=`${pct}%`;document.querySelector(".tank-visual .water").style.height=`${pct}%`;
    $("lowWaterAlert").hidden=!(cistern!==null&&cistern<=r.alertLiters);
    $("alertText").textContent=cistern===null?"Registre uma medição da cisterna.":`A cisterna está com cerca de ${number(cistern)} L, abaixo do limite de ${number(r.alertLiters)} L.`;
    const overflow=cistern!==null&&cistern>r.capacityLiters;
    $("cisternOverflowAlert").hidden=!overflow;
    if($("cisternOverflowText"))$("cisternOverflowText").textContent=`Estimativa de ${number(cistern)} L para capacidade de ${number(r.capacityLiters)} L. Confira os registros e faça uma medição manual.`;
    const consumption=calculateConsumption();$("autonomy").textContent=cistern!==null&&consumption>0?`≈ ${Math.ceil(cistern/consumption)} dias`:"Sem estimativa";
    $("dailyUse").textContent=consumption===null?"Sem média":`${number(consumption)} L/dia`;
    const spend=state.supplies.filter(x=>x.date.startsWith(currentMonthKey())).reduce((s,x)=>s+(x.valueCents||0),0);$("monthlySpend").textContent=money(spend);
    $("lastMeasurement").textContent=cm?dateTimeLabel(cm.date,cm.time):"Não registrada";
    $("estimateNote").textContent=cistern===null?"Informe o volume atual da cisterna para iniciar o acompanhamento.":"Volume estimado com base nas medições e movimentações. Faça medições manuais para corrigir possíveis perdas.";
    updateTransferHint();
  }
  function updateTransferHint(){const estimate=estimateAt("cisterna");if($('transferBalanceHint'))$('transferBalanceHint').textContent=`Volume estimado disponível na cisterna: ${estimate===null?"indisponível":number(estimate)+" L"}`;}
  function allRecords(){return [...state.supplies.map(x=>({...x,kind:"abastecimento",at:stamp(x)})),...state.transfers.map(x=>({...x,kind:"transferencia",at:stamp(x)})),...state.measurements.map(x=>({...x,kind:"medicao",at:stamp(x)}))].sort((a,b)=>b.at.localeCompare(a.at));}
  function escapeHtml(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
  function renderHistory(){const records=allRecords().filter(x=>activeFilter==="todos"||x.kind===activeFilter);$("historyList").innerHTML="";$("emptyHistory").hidden=records.length>0;records.forEach(x=>{const tank=x.tank==="caixa"?" da caixa-d’água":" da cisterna";const title=x.kind==="abastecimento"?(x.type==="completo"?"Abastecimento completo":x.type==="complemento"?"Complemento de água":"Abastecimento parcial"):x.kind==="transferencia"?"Transferência para a caixa":(x.source==="abastecimento"?"Medição automática após abastecimento":"Medição")+(x.tank==="caixa"?" da caixa":" da cisterna");const icon=x.kind==="abastecimento"?"🚚":x.kind==="transferencia"?"↥":"💧";const amount=x.kind==="abastecimento"?(x.liters!=null?`${number(x.liters)} L`:"Litros não informados"):`${number(x.liters)} L`;const extra=x.kind==="abastecimento"?(x.valueCents!=null?money(x.valueCents):"Valor não informado"):x.kind==="transferencia"?"Transferidos":`Volume observado${tank}`;const card=document.createElement("article");card.className="history-card";card.innerHTML=`<div class="history-icon ${x.kind==="abastecimento"?"supply":x.kind==="transferencia"?"transfer":"measure"}">${icon}</div><div class="history-main"><strong>${escapeHtml(title)}</strong><small>${dateTimeLabel(x.date,x.time)}${x.notes?" • "+escapeHtml(x.notes):""}</small></div><div class="history-value">${amount}<small>${escapeHtml(extra)}</small></div>`;$('historyList').appendChild(card);});}
  function renderReports(){const month=$("reportMonth").value||currentMonthKey(),supplies=state.supplies.filter(x=>x.date.startsWith(month)),transfers=state.transfers.filter(x=>x.date.startsWith(month));$("reportSpend").textContent=money(supplies.reduce((s,x)=>s+(x.valueCents||0),0));$("reportLiters").textContent=`${number(supplies.reduce((s,x)=>s+(x.liters||0),0))} L`;$ ("reportTransferred").textContent=`${number(transfers.reduce((s,x)=>s+x.liters,0))} L`;const c=calculateConsumption();$("reportConsumption").textContent=c===null?"Sem dados":`${number(c)} L/dia`;}
  function fillSettings(){$("settingName").value=state.residence.name;$("settingCapacity").value=state.residence.capacityLiters;$("settingAlert").value=state.residence.alertLiters;$("settingPrice").value=formatCentsInput(String(state.residence.referencePriceCents));}
  function renderAll(){renderDashboard();renderHistory();renderReports();}
  attachMoneyMask($("supplyValue"));
  attachMoneyMask($("settingPrice"));
  document.querySelectorAll("[data-view]").forEach(b=>b.addEventListener("click",()=>showView(b.dataset.view)));$("openSettings").addEventListener("click",()=>showView("settings"));
  document.querySelectorAll(".filter").forEach(b=>b.addEventListener("click",()=>{activeFilter=b.dataset.filter;document.querySelectorAll(".filter").forEach(x=>x.classList.toggle("active",x===b));renderHistory();}));
  // Supply preview: computes the cistern volume at the entered timestamp, then validates the capacity.
  function supplyProjection(){const liters=$('supplyLiters').value===""?null:Number($('supplyLiters').value),at=`${$('supplyDate').value}T${$('supplyTime').value||"00:00"}`;const before=estimateAt("cisterna",at);return {liters,before,after:before!==null&&liters!==null?before+liters:null};}
  ["supplyLiters","supplyDate","supplyTime"].forEach(id=>$(id).addEventListener("input",()=>{const p=supplyProjection();const hint=$('supplyProjectionHint');if(hint)hint.textContent=p.after===null?"Preencha litros, data e hora para calcular o volume estimado.":`Após abastecer: ${number(p.after)} L (capacidade ${number(state.residence.capacityLiters)} L).`; }));
  $('supplyForm').addEventListener("submit",async e=>{
    e.preventDefault();
    const liters=$('supplyLiters').value===""?null:Number($('supplyLiters').value),valueRaw=$('supplyValue').value;
    if((liters===null||liters<=0)&&centsFromInput(valueRaw)===0){showToast("Informe litros, valor pago ou ambos.");return;}
    if(liters!==null&&(!Number.isFinite(liters)||liters<=0)){showToast("Os litros devem ser maiores que zero.");return;}
    const projection=supplyProjection();
    if(liters!==null&&projection.after!==null&&projection.after>state.residence.capacityLiters){
      const ok=confirm(`ATENÇÃO: o abastecimento levaria a estimativa para ${number(projection.after)} L, acima da capacidade de ${number(state.residence.capacityLiters)} L. Revise os litros ou confirme o registro excepcional.\n\nRegistrar mesmo assim?`);
      if(!ok)return;
    }
    const button=$('supplyForm').querySelector('[type="submit"]'); if(button)button.disabled=true;
    const record={id:makeId(),type:$('supplyType').value,date:$('supplyDate').value,time:$('supplyTime').value,liters,valueCents:centsFromInput(valueRaw)===0?null:centsFromInput(valueRaw),payment:$('supplyPayment').value,notes:$('supplyNotes').value.trim(),createdAt:new Date().toISOString(),registeredBy:(auth.currentUser?.displayName||auth.currentUser?.email||"Usuário")};
    try{
      // O volume informado no abastecimento também estabelece uma medição automática:
      // sem medição anterior, os litros recebidos viram o saldo inicial; caso contrário,
      // são somados ao saldo estimado existente.
      let automaticMeasurement = null;
      if (liters !== null) {
        const currentVolume = estimateAt("cisterna", `${record.date}T${record.time || "00:00"}`);
        const resultingVolume = currentVolume === null ? liters : currentVolume + liters;
        automaticMeasurement = {
          id: makeId(), tank: "cisterna", date: record.date, time: record.time,
          liters: resultingVolume, source: "abastecimento", sourceRecordId: record.id,
          notes: `Medição automática gerada pelo abastecimento de ${number(liters)} L.`,
          createdAt: new Date(Date.now() + 1).toISOString(),
          registeredBy: (auth.currentUser?.displayName || auth.currentUser?.email || "Usuário")
        };
      }
      // Gravação remota antes de mostrar sucesso. O registro de abastecimento e a
      // medição automática são persistidos no Firestore e depois refletidos na tela.
      const supplyAudit={id:makeId(),action:"criado",recordId:record.id,description:"Abastecimento registrado",createdAt:new Date().toISOString()};
      await writeResidenceRecord("supplies",record);
      if (automaticMeasurement) await writeResidenceRecord("measurements",automaticMeasurement);
      await writeResidenceRecord("audit",supplyAudit);
      upsertById(state.supplies,record);
      if (automaticMeasurement) upsertById(state.measurements,automaticMeasurement);
      upsertById(state.audit,supplyAudit);
      localStorage.setItem(STORAGE_KEY,JSON.stringify(state));
      renderAll();
      $('supplyForm').reset();setDefaultDateFields();
      showToast(automaticMeasurement
        ? `Abastecimento salvo. Volume atualizado automaticamente para ${number(automaticMeasurement.liters)} L.`
        : "Abastecimento salvo. Como os litros não foram informados, o volume não foi alterado.");
      showView("dashboard");
    }catch(error){showToast("Não foi possível salvar o abastecimento: "+friendlyError(error));}
    finally{if(button)button.disabled=false;}
  });
  $('transferForm').addEventListener("submit",async e=>{
    e.preventDefault();const liters=Number($('transferLiters').value),cistern=estimateAt("cisterna");
    if(!Number.isFinite(liters)||liters<=0){showToast("Informe uma quantidade válida.");return;}
    if(cistern===null){showToast("Registre primeiro o volume atual da cisterna.");return;}
    if(liters>cistern){showToast("A transferência não pode exceder o volume estimado disponível na cisterna.");return;}
    const button=$('transferForm').querySelector('[type="submit"]');if(button)button.disabled=true;
    const record={id:makeId(),date:$('transferDate').value,time:$('transferTime').value,liters,notes:$('transferNotes').value.trim(),createdAt:new Date().toISOString(),registeredBy:(auth.currentUser?.displayName||auth.currentUser?.email||"Usuário")};
    try{await persistNewRecord("transfers","transfers",record,"Transferência para a caixa registrada");$('transferForm').reset();setDefaultDateFields();$('transferLiters').value="1000";showToast("Transferência salva no Firebase. Confira o nível real da caixa.");showView("dashboard");}
    catch(error){showToast("Não foi possível salvar a transferência: "+friendlyError(error));}
    finally{if(button)button.disabled=false;}
  });
  $('measurementForm').addEventListener("submit",async e=>{
    e.preventDefault();const tank="cisterna",liters=Number($('measurementVolume').value),capacity=state.residence.capacityLiters;
    if(!Number.isFinite(liters)||liters<0||liters>capacity){showToast(`Informe um volume entre 0 e ${number(capacity)} litros para este reservatório.`);return;}
    const button=$('measurementForm').querySelector('[type="submit"]');if(button)button.disabled=true;
    const record={id:makeId(),tank,date:$('measurementDate').value,time:$('measurementTime').value,liters,notes:$('measurementNotes').value.trim(),createdAt:new Date().toISOString(),registeredBy:(auth.currentUser?.displayName||auth.currentUser?.email||"Usuário")};
    try{await persistNewRecord("measurements","measurements",record,"Medição manual da cisterna registrada");state.residence.initialSetupDone=true;localStorage.setItem(STORAGE_KEY,JSON.stringify(state));$('measurementForm').reset();$('measurementVolume').max=state.residence.capacityLiters;setDefaultDateFields();renderAll();showToast(`Medição salva no Firebase: ${number(liters)} litros.`);showView("dashboard");}
    catch(error){showToast("Não foi possível salvar a medição: "+friendlyError(error));}
    finally{if(button)button.disabled=false;}
  });
  $('settingsForm').addEventListener("submit",async e=>{e.preventDefault();const capacity=Number($('settingCapacity').value),alert=Number($('settingAlert').value),price=centsFromInput($('settingPrice').value);if(capacity<=0||alert<0||alert>capacity||price<0){showToast("Confira capacidade, alerta e preço.");return;}const previous={...state.residence};state.residence.name=$('settingName').value.trim()||"Minha residência";state.residence.capacityLiters=capacity;state.residence.alertLiters=alert;state.residence.referencePriceCents=price;try{if(!currentUser||!cloudReady)throw new Error("A conexão com a residência ainda não está pronta.");await saveResidenceConfiguration(state.residence);recordAudit("alterado",state.residence.id,"Configurações alteradas");saveState();showToast("Configurações salvas no Firebase.");showView("dashboard");}catch(error){state.residence=previous;renderAll();showToast("Não foi possível salvar as configurações: "+friendlyError(error));}});
  $('reportMonth').addEventListener("change",renderReports);
  function downloadBlob(content,filename,type){const blob=new Blob([content],{type}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  $('exportCsv').addEventListener("click",()=>{const rows=[["tipo","reservatorio","data","hora","litros","valor_centavos","observacoes","responsavel"]];allRecords().forEach(x=>rows.push([x.kind,x.tank||"cisterna",x.date,x.time,x.liters??"",x.valueCents??"",x.notes||"",x.registeredBy||"Usuário local"]));downloadBlob("\uFEFF"+rows.map(row=>row.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(";")).join("\r\n"),"controle-agua-registros.csv","text/csv;charset=utf-8");showToast("CSV exportado.");});
  $('backupJson').addEventListener("click",()=>{downloadBlob(JSON.stringify(state,null,2),"backup-controle-agua.json","application/json");showToast("Backup preparado.");});
  $('restoreJson').addEventListener("change",async e=>{const file=e.target.files[0];if(!file)return;try{const imported=JSON.parse(await file.text());if(!imported.residence||!Array.isArray(imported.measurements)||!Array.isArray(imported.supplies)||!Array.isArray(imported.transfers))throw Error("Formato inválido");if(!confirm("Restaurar este backup substituirá os dados atuais. Continuar?"))return;state=imported;state.residence.boxCapacityLiters=state.residence.boxCapacityLiters||1000;state.measurements.forEach(m=>m.tank=m.tank||"cisterna");saveState();showToast("Backup restaurado.");}catch(err){showToast("Não foi possível restaurar esse arquivo.");}finally{e.target.value="";}});
  $('clearLocalData').addEventListener("click",()=>{
    if(!confirm("Limpar os dados locais deste dispositivo? Os dados compartilhados no Firebase não serão apagados."))return;
    clearTimeout(cloudWriteTimer);
    // Marca os dados locais como limpos e aguarda o próximo snapshot oficial do Firebase.
    localStorage.removeItem(STORAGE_KEY);
    state=defaultState();
    localStorage.setItem(STORAGE_KEY,JSON.stringify(state));
    renderAll();
    showToast("Dados locais limpos. Os dados compartilhados continuam no Firebase.");
  });
  $('clearCloudData').addEventListener("click",async()=>{
    if(!currentUser || !cloudReady){showToast("Conecte-se ao Firebase antes de excluir dados compartilhados.");return;}
    const confirmed=confirm("ATENÇÃO: isso excluirá do Firebase todos os abastecimentos, transferências, medições e registros de auditoria da residência, para você e Barbara. As contas de acesso serão preservadas. Deseja continuar?");
    if(!confirmed)return;
    const typed=prompt('Para confirmar a exclusão compartilhada, digite EXCLUIR:');
    if(typed!=="EXCLUIR"){showToast("Exclusão cancelada.");return;}
    try{
      clearTimeout(cloudWriteTimer); cloudReady=false;
      await deleteResidenceRecords();
      state=defaultState();
      localStorage.setItem(STORAGE_KEY,JSON.stringify(state));
      // Reativa escrita somente após concluir a exclusão remota.
      cloudReady=true; renderAll(); showToast("Dados compartilhados excluídos do Firebase e deste dispositivo.");
    }catch(err){cloudReady=true;showToast("Não foi possível excluir os dados compartilhados: "+friendlyError(err));}
  });
  setDefaultDateFields();$('transferLiters').value="1000";$('measurementVolume').max=state.residence.capacityLiters;
  renderAll();
})();
