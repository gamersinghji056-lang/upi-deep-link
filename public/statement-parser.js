(function () {
  "use strict";

  const ACCEPTED_EXTENSIONS = [".pdf", ".csv", ".xls", ".xlsx"];
  const RUNTIME = "/vendor/smart-upi-parser-runtime/";
  const CREDIT_TOKENS = /\b(cr|credit|credited|credit\s*amount|credit\s*value|deposit|deposits|deposited|received|receive|recd|incoming|inward|by\s+transfer)\b/i;
  const DEBIT_TOKENS = /\b(dr|debit|debited|debit\s*amount|withdraw(al|l|als|n)?|sent|paid|payment\s+to|outgoing|outward|to\s+transfer)\b/i;
  const UPI_KEYWORDS = [
    /upi/i,
    /\bmpay\b[\s/:\-|]*upi/i,
    /upi[\s/:\-|]*(cr|dr|trtr|coll|collect|p2a|p2m|qr|pay|paymt|payment|transfer|receive[d]?|credit|refund)/i,
    /(collect|payment|received)[\s/:\-|]*(via|through)?[\s/:\-|]*upi/i,
    /\bvpa\b/i
  ];
  const NOISE_PATTERNS = [
    /opening\s*balance/i,/closing\s*balance/i,/available\s*balance/i,/balance\s*(b\/?f|c\/?f|brought|carried)/i,
    /^\s*(b\/?f|c\/?f)\s*$/i,/total\s*(debit|credit|amount)?/i,/grand\s*total/i,/summary/i,
    /statement\s*(of|period|from)/i,/account\s*(number|no|holder|type|description|branch)/i,/customer\s*(id|name|no)/i,
    /nominee/i,/\bifsc\b/i,/\bmicr\b/i,/branch\s*(name|code|address)/i,/page\s*\d+\s*(of|\/)\s*\d+/i,
    /this\s+is\s+a\s+(computer|system)\s+generated/i,/registered\s+office/i,/generated\s+on/i
  ];
  const MONTHS = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12};
  const DATE_PATTERNS = [
    /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/,
    /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/,
    /\b(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s,]*(\d{2,4})\b/,
    /\b([A-Za-z]{3,9})[-\s](\d{1,2})[-\s,]*(\d{4})\b/
  ];
  const AMOUNT_RE = /^-?(?:\d{1,3}(?:,\d{2,3})*|\d+)(?:\.\d{1,4})?$/;
  const RULES = [
    ["valueDate",[/value\s*date/i,/val\s*dt/i,/post(ing)?\s*date/i]],
    ["date",[/(txn|tran|transaction|book(ing)?)?\s*date/i,/^date$/i,/^dt\.?$/i]],
    ["narration",[/narration/i,/description/i,/particular/i,/remark/i,/details/i,/transaction\s*(info|remarks|details)/i,/^text$/i]],
    ["reference",[/(ref|cheque|chq|utr|rrn)\s*(no|number|id)?/i,/reference/i]],
    ["debit",[/debit/i,/withdraw/i,/paid\s*out/i,/dr\s*am(oun)?t/i,/^dr\.?$/i,/outgoing/i]],
    ["credit",[/credit/i,/deposit/i,/paid\s*in/i,/cr\s*am(oun)?t/i,/^cr\.?$/i,/received/i,/incoming/i]],
    ["drcr",[/(dr|debit)\s*[/|-]\s*(cr|credit)/i,/(cr|credit)\s*[/|-]\s*(dr|debit)/i,/txn\s*type/i,/type/i,/indicator/i]],
    ["balance",[/balance/i,/bal\.?$/i]],
    ["amount",[/amount/i,/^amt\.?$/i,/value/i]]
  ];

  function clean(value) { return value == null ? "" : String(value).replace(/\u00a0/g," ").replace(/\s+/g," ").trim(); }
  function pad(n) { return String(n).padStart(2,"0"); }
  function fullYear(y) { if (y >= 1000) return y; return y >= 70 ? 1900 + y : 2000 + y; }
  function parseDate(value) {
    const text = clean(value); if (!text) return null;
    for (let i=0;i<DATE_PATTERNS.length;i++) {
      const m = DATE_PATTERNS[i].exec(text); if (!m) continue;
      let d,mo,y;
      if (i===0) { d=Number(m[1]); mo=Number(m[2]); y=fullYear(Number(m[3])); if (mo>12 && d<=12) [d,mo]=[mo,d]; }
      else if (i===1) { y=fullYear(Number(m[1])); mo=Number(m[2]); d=Number(m[3]); }
      else if (i===2) { d=Number(m[1]); mo=MONTHS[m[2].slice(0,3).toLowerCase()]||0; y=fullYear(Number(m[3])); }
      else { mo=MONTHS[m[1].slice(0,3).toLowerCase()]||0; d=Number(m[2]); y=fullYear(Number(m[3])); }
      if (!mo||mo<1||mo>12||!d||d<1||d>31||y<1900||y>2200) continue;
      return `${pad(d)}/${pad(mo)}/${y}`;
    }
    return null;
  }
  function parseAmount(value) {
    let text=clean(value); if(!text) return null;
    text=text.replace(/(inr|rs\.?|₹)/gi,"").trim(); let negative=false;
    if (/^\(.*\)$/.test(text)) { negative=true; text=text.slice(1,-1).trim(); }
    const suffix=/\b(cr|dr)\b\.?$/i.exec(text); if(suffix) text=text.slice(0,suffix.index).trim();
    if(/^[+-]/.test(text)){negative=negative||text.startsWith("-");text=text.slice(1).trim();}
    if(!AMOUNT_RE.test(text)) return null;
    const num=Number(text.replace(/,/g,"")); return Number.isFinite(num)?(negative?-num:num):null;
  }
  function isNoiseRow(text){ return !text || NOISE_PATTERNS.some(p=>p.test(text)); }
  function matchesMode(text){ return UPI_KEYWORDS.some(k=>k.test(text)); }
  function formatAmount(value){ return Math.abs(value).toFixed(2); }

  function headerScore(row){
    const map={}; let score=0;
    row.cells.forEach((cell,i)=>{
      const value=clean(cell); if(!value||value.length>40||parseAmount(value)!==null)return;
      for(const [role,patterns] of RULES){
        if(patterns.some(p=>p.test(value))){ if(map[role]===undefined){map[role]=i;score++;} return; }
      }
    });
    const hasMoney=map.credit!==undefined||map.debit!==undefined||map.amount!==undefined||map.balance!==undefined;
    if(map.date===undefined&&map.valueDate===undefined)return{score:0,map:{}};
    if(!hasMoney)return{score:0,map:{}};
    return{score,map};
  }
  function isHeaderLikeRow(row){return headerScore(row).score>=3;}
  function detectColumns(rows){let best={map:{},headerIndex:-1,score:0};for(let i=0;i<Math.min(rows.length,400);i++){const x=headerScore(rows[i]);if(x.score>best.score)best={map:x.map,headerIndex:i,score:x.score};}return best;}

  function numericCells(row){const out=[];row.cells.forEach((cell,index)=>{const value=parseAmount(cell);if(value===null)return;out.push({index,value,raw:clean(cell)});});return out;}
  function looksLikeMoney(raw){return /[.,]/.test(raw)||/\b(cr|dr)\b/i.test(raw);}
  function resolveDate(row,map){
    if(map.date!==undefined){const d=parseDate(row.cells[map.date]||"");if(d)return d;}
    if(map.valueDate!==undefined){const d=parseDate(row.cells[map.valueDate]||"");if(d)return d;}
    for(const cell of row.cells){const d=parseDate(cell);if(d)return d;}return null;
  }
  function resolveReference(row){
    const primary=[],fallback=[];
    row.cells.forEach(cell=>{
      const text=clean(cell),tokens=text.split(/[^0-9]+/).filter(Boolean),cellHasMode=matchesMode(text);
      tokens.forEach(token=>{
        const isPrimary=/^\d{12}$/.test(token),isFallback=!isPrimary&&/^\d{10,22}$/.test(token);
        if(!isPrimary&&!isFallback)return;
        if(/^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])/.test(token))return;
        let score=1;if(cellHasMode)score+=3;
        const near=new RegExp(`upi[^0-9a-z]{0,12}(?:[a-z0-9@.\\-]*[^0-9a-z]){0,6}${token}`,"i");if(near.test(text))score+=2;
        (isPrimary?primary:fallback).push({value:token,score});
      });
    });
    const pool=primary.length?primary:fallback;if(!pool.length)return null;pool.sort((a,b)=>b.score-a.score);return pool[0].value;
  }
  function resolveBalance(row,map,nums){
    if(map.balance!==undefined){const direct=nums.find(n=>n.index===map.balance);if(direct)return direct;const near=nums.find(n=>Math.abs(n.index-map.balance)<=1&&looksLikeMoney(n.raw));if(near)return near;}
    const money=nums.filter(n=>looksLikeMoney(n.raw));return money.length>1?money[money.length-1]:null;
  }
  function reservedIndices(map,own){const set=new Set();Object.keys(map).forEach(role=>{const index=map[role];if(index!==undefined&&!own.includes(role))set.add(index);});return set;}
  function readMoneyColumn(index,nums,balanceIndex,reserved){
    if(index===undefined)return null;const anyMoney=nums.some(n=>looksLikeMoney(n.raw));
    const exact=nums.find(n=>n.index===index&&Math.abs(n.value)>0&&(looksLikeMoney(n.raw)||!anyMoney));if(exact)return exact;
    const drifted=nums.filter(n=>Math.abs(n.index-index)<=1&&n.index!==balanceIndex&&!reserved.has(n.index)&&Math.abs(n.value)>0&&looksLikeMoney(n.raw));
    return drifted.length===1?drifted[0]:null;
  }
  function detectMarker(row,map){
    if(map.drcr!==undefined){const value=clean(row.cells[map.drcr]||"");if(/^c(r|redit)?$/i.test(value)||CREDIT_TOKENS.test(value))return"credit";if(/^d(r|ebit)?$/i.test(value)||DEBIT_TOKENS.test(value))return"debit";}
    for(const cell of row.cells){const value=clean(cell);if(/^c(r|redit)?\.?$/i.test(value))return"credit";if(/^d(r|ebit)?\.?$/i.test(value))return"debit";}
    const debit=DEBIT_TOKENS.test(row.text),credit=CREDIT_TOKENS.test(row.text);if(credit&&!debit)return"credit";if(debit&&!credit)return"debit";return"unknown";
  }
  function withBalance(ctx,balanceCell,amount,fallback){const previous=ctx.prevBalance;if(previous==null||!balanceCell)return fallback;const delta=Math.abs(balanceCell.value)-previous;if(Math.abs(delta-amount)<=0.01)return"credit";if(Math.abs(delta+amount)<=0.01)return"debit";return fallback;}
  function resolveDirectionAndAmount(row,map,nums,ctx){
    const balanceCell=resolveBalance(row,map,nums),balanceIndex=balanceCell?balanceCell.index:null,marker=detectMarker(row,map);
    if(map.credit!==undefined||map.debit!==undefined){
      const credit=readMoneyColumn(map.credit,nums,balanceIndex,reservedIndices(map,["credit"]));
      const debit=readMoneyColumn(map.debit,nums,balanceIndex,reservedIndices(map,["debit"]));
      if(credit&&(!debit||credit.index!==debit.index))return{direction:"credit",amount:Math.abs(credit.value)};
      if(debit&&(!credit||credit.index!==debit.index))return{direction:"debit",amount:Math.abs(debit.value)};
    }
    if(map.amount!==undefined&&map.amount!==balanceIndex){
      const amount=parseAmount(row.cells[map.amount]||"");if(amount!==null&&amount!==0){if(marker!=="unknown")return{direction:marker,amount:Math.abs(amount)};if(amount>0)return{direction:withBalance(ctx,balanceCell,amount,"credit"),amount};return{direction:"debit",amount:Math.abs(amount)};}
    }
    const money=nums.filter(n=>n.index!==balanceIndex&&looksLikeMoney(n.raw)&&Math.abs(n.value)>0);if(!money.length)return{direction:marker,amount:null};
    const chosen=money[money.length-1],amount=Math.abs(chosen.value);if(marker!=="unknown")return{direction:marker,amount};return{direction:withBalance(ctx,balanceCell,amount,"unknown"),amount};
  }
  function balanceOfRow(row,map){const cell=resolveBalance(row,map,numericCells(row));return cell?Math.abs(cell.value):null;}
  function extractFromRow(row,map,ctx){
    if(isNoiseRow(row.text)||!matchesMode(row.text))return null;const date=resolveDate(row,map);if(!date)return null;const utr=resolveReference(row);if(!utr||!/^[0-9]{12}$/.test(utr))return null;
    const nums=numericCells(row),resolved=resolveDirectionAndAmount(row,map,nums,ctx),amount=resolved.amount;if(amount===null||amount===0||resolved.direction!=="credit")return null;
    if(String(Math.round(amount))===String(Number(utr))||amount>=1e8)return null;return{date,utr,amount:formatAmount(amount),mode:"UPI"};
  }

  function isTransactionLike(row){const hasDate=row.cells.some(c=>parseDate(c)!==null),hasMoney=row.cells.some(c=>parseAmount(c)!==null&&/[.,]/.test(c));return hasDate&&hasMoney;}
  function stitchWrappedRows(rows){
    const out=[];let pending=[];const flushInto=target=>{for(const held of pending){target.cells.push(...held.cells);target.text=`${target.text} ${held.text}`.trim();}pending=[];};
    for(const row of rows){const starts=row.cells.some(c=>parseDate(c)!==null);if(starts||isHeaderLikeRow(row)){const copy={...row,cells:[...row.cells]};if(starts)flushInto(copy);else pending=[];out.push(copy);continue;}const previous=out[out.length-1];if(previous&&isTransactionLike(previous)){previous.cells.push(...row.cells);previous.text=`${previous.text} ${row.text}`.trim();continue;}if(!isNoiseRow(row.text)&&pending.length<3)pending.push(row);}return out;
  }
  function dedupe(items){const seen=new Set();return items.filter(t=>{const key=`${t.date}|${t.utr}|${t.amount}|${t.mode}`;if(seen.has(key))return false;seen.add(key);return true;});}

  let xlsxLoading=null;
  function ensureXlsx(){
    if(window.XLSX)return Promise.resolve(window.XLSX);if(xlsxLoading)return xlsxLoading;
    xlsxLoading=new Promise((resolve,reject)=>{const s=document.createElement("script");s.src=RUNTIME+"xlsx.full.min.js";s.onload=()=>window.XLSX?resolve(window.XLSX):reject(new Error("XLSX runtime failed to load"));s.onerror=()=>reject(new Error("XLSX runtime is unavailable"));document.head.appendChild(s);});return xlsxLoading;
  }
  function formatCell(value){if(value instanceof Date){return `${pad(value.getDate())}/${pad(value.getMonth()+1)}/${value.getFullYear()}`;}return clean(value);}
  async function readTabular(file){
    const XLSX=await ensureXlsx();let workbook;try{workbook=XLSX.read(await file.arrayBuffer(),{type:"array",cellDates:true,raw:false});}catch{throw new Error("Unable to read this bank statement.");}
    const rows=[];let index=0;for(const name of workbook.SheetNames){const sheet=workbook.Sheets[name];if(!sheet)continue;const grid=XLSX.utils.sheet_to_json(sheet,{header:1,blankrows:false,defval:"",raw:false});for(const row of grid){const cells=Array.from(row||[]).map(formatCell);while(cells.length&&cells[cells.length-1]==="")cells.pop();const text=cells.join(" ").trim();if(text)rows.push({cells,text,source:name,index:index++});}}
    if(!rows.length)throw new Error("Unable to read this bank statement.");return rows;
  }

  function clusterRows(items){if(!items.length)return[];const sorted=[...items].sort((a,b)=>b.y-a.y||a.x-b.x),lines=[];let current=[sorted[0]],baseline=sorted[0].y;for(let i=1;i<sorted.length;i++){const item=sorted[i];if(Math.abs(item.y-baseline)<=3)current.push(item);else{lines.push(current);current=[item];baseline=item.y;}}lines.push(current);return lines.map(line=>line.sort((a,b)=>a.x-b.x));}
  function clusterCells(line){const chunks=[];if(!line.length)return chunks;let buffer=line[0].str,start=line[0].x,end=line[0].x+line[0].w;for(let i=1;i<line.length;i++){const prev=line[i-1],item=line[i],gap=item.x-(prev.x+prev.w);if(gap>6){if(buffer.trim())chunks.push({text:buffer.trim(),x:start,end});buffer=item.str;start=item.x;}else buffer+=(gap>0.8?" ":"")+item.str;end=item.x+item.w;}if(buffer.trim())chunks.push({text:buffer.trim(),x:start,end});return chunks;}
  function isDataLine(chunks){return chunks.length>=3&&chunks.some(c=>c.text.length<=30&&parseDate(c.text)!==null);}
  function buildBands(lines){const spans=[];for(const line of lines){if(!isDataLine(line))continue;for(const c of line)spans.push({start:c.x,end:Math.max(c.end,c.x+1)});}if(!spans.length)return[];spans.sort((a,b)=>a.start-b.start);const bands=[{...spans[0]}];for(const span of spans.slice(1)){const last=bands[bands.length-1];if(span.start<=last.end+3)last.end=Math.max(last.end,span.end);else bands.push({...span});}return bands;}
  function snapToBands(chunks,bands){const slots=bands.map(()=>"");for(const chunk of chunks){let best=0,bestOverlap=0,bestDistance=Infinity;bands.forEach((band,i)=>{const overlap=Math.max(0,Math.min(chunk.end,band.end)-Math.max(chunk.x,band.start)),distance=overlap>0?0:Math.min(Math.abs(chunk.x-band.end),Math.abs(band.start-chunk.end));if(overlap>bestOverlap||(bestOverlap===0&&distance<bestDistance)){bestOverlap=Math.max(bestOverlap,overlap);bestDistance=distance;best=i;}});slots[best]=slots[best]?`${slots[best]} ${chunk.text}`:chunk.text;}return slots;}
  let pdfModule=null;
  async function readPdf(file){
    try{if(!pdfModule)pdfModule=await import(RUNTIME+"pdf.mjs");pdfModule.GlobalWorkerOptions.workerSrc=RUNTIME+"pdf.worker.min.mjs";}catch{throw new Error("Unable to load the PDF statement reader.");}
    let doc;try{doc=await pdfModule.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise;}catch(err){const m=String(err&&err.message||"");if(/password/i.test(m))throw new Error("This PDF is password protected. Upload the unlocked statement.");if(/invalid pdf|corrupt/i.test(m))throw new Error("This PDF appears corrupted or invalid.");throw new Error("Unable to read this bank statement.");}
    const rows=[];let index=0;for(let p=1;p<=doc.numPages;p++){const page=await doc.getPage(p),content=await page.getTextContent(),items=[];for(const raw of content.items){const str=clean(raw.str);if(!str||!raw.transform)continue;items.push({str,x:raw.transform[4]||0,y:raw.transform[5]||0,w:raw.width||0});}const lines=clusterRows(items).map(clusterCells).filter(c=>c.length),bands=buildBands(lines);for(const chunks of lines){const cells=bands.length>=3?snapToBands(chunks,bands):chunks.map(c=>c.text),text=cells.join(" ").trim();if(text)rows.push({cells,text,source:`page ${p}`,index:index++});}}
    if(!rows.length)throw new Error("This PDF has no readable text layer. Upload the original bank-generated PDF.");return rows;
  }

  async function parseStatement(file){
    const dot=file.name.lastIndexOf("."),ext=dot===-1?"":file.name.slice(dot).toLowerCase();if(!ACCEPTED_EXTENSIONS.includes(ext))throw new Error("Unsupported file type. Upload PDF, XLS, XLSX or CSV.");
    let rows=ext===".pdf"?stitchWrappedRows(await readPdf(file)):await readTabular(file);const detected=detectColumns(rows),transactions=[];let prevBalance=null;
    for(const row of rows){if(row.index===detected.headerIndex)continue;const txn=extractFromRow(row,detected.map,{prevBalance});if(txn)transactions.push(txn);const balance=balanceOfRow(row,detected.map);if(balance!==null)prevBalance=balance;}
    return{transactions:dedupe(transactions),rowsScanned:rows.length,fileName:file.name};
  }

  async function hashFile(file){const digest=await crypto.subtle.digest("SHA-256",await file.arrayBuffer());return Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,"0")).join("");}
  function esc(value){return String(value??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;").replace(/'/g,"&#039;");}
  function money(value){const n=Number(value);return Number.isFinite(n)?n.toFixed(2):"—";}
  function setText(id,value){const el=document.getElementById(id);if(el)el.textContent=value;}
  function show(id,visible){const el=document.getElementById(id);if(el)el.hidden=!visible;}

  async function sendForMatch(file,result){
    const response=await fetch("/api/statements/match",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({fileName:file.name,fileHash:await hashFile(file),rowsScanned:result.rowsScanned,transactions:result.transactions})});
    if(response.status===401){location.replace("/login");throw new Error("Dashboard login required");}
    const data=await response.json();if(!response.ok)throw new Error(data.error||"Could not match statement transactions");return data;
  }

  function renderResults(data){
    setText("statementCredits",String(data.creditsFound||0));setText("statementMatched",String(data.matched||0));setText("statementUnmatched",String(data.unmatched||0));setText("statementRows",String(data.rowsScanned||0));
    const body=document.getElementById("statementResultsBody");if(!body)return;const rows=Array.isArray(data.results)?data.results:[];
    body.innerHTML=rows.length?rows.map(r=>`<tr><td>${esc(r.date)}</td><td class="otp-code">${esc(r.utr)}</td><td>₹ ${esc(money(r.amount))}</td><td>${r.paymentId?esc(r.paymentId):'—'}</td><td><span class="statement-state ${r.status==='matched'?'matched':'unmatched'}">${r.status==='matched'?'Matched':'No order match'}</span></td></tr>`).join(""):'<tr><td colspan="5" class="muted">No UPI credit transactions found.</td></tr>';
    show("statementResultCard",true);
  }

  async function handleFile(file){
    const msg=document.getElementById("statementMsg"),button=document.getElementById("parseStatementBtn");if(!file)return;
    if(msg){msg.className="msg muted";msg.textContent="Reading statement locally with Smart UPI Parser...";}if(button){button.disabled=true;button.textContent="Parsing...";}
    try{
      const result=await parseStatement(file);if(!result.transactions.length)throw new Error("No UPI credit transactions found in this statement.");
      if(msg)msg.textContent=`${result.transactions.length} UPI credits extracted locally. Matching exact UTR + amount with WPAY orders...`;
      const matched=await sendForMatch(file,result);renderResults(matched);if(msg){msg.className="msg ok";msg.textContent=`Done: ${matched.matched} order(s) verified, ${matched.unmatched} statement credit(s) unmatched.`;}
    }catch(error){if(msg){msg.className="msg err";msg.textContent=error.message||"Unable to read this statement.";}show("statementResultCard",false);}finally{if(button){button.disabled=false;button.textContent="Parse & Match UTRs";}}
  }

  function bind(){
    const input=document.getElementById("statementFile"),button=document.getElementById("parseStatementBtn"),drop=document.getElementById("statementDrop");if(!input||!button)return;
    button.addEventListener("click",()=>{const file=input.files&&input.files[0];if(!file){setText("statementMsg","Choose a bank statement first.");return;}handleFile(file);});
    input.addEventListener("change",()=>{const file=input.files&&input.files[0];setText("statementFileName",file?file.name:"No file selected");show("statementResultCard",false);});
    if(drop){["dragenter","dragover"].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.add("drag");}));["dragleave","drop"].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.remove("drag");}));drop.addEventListener("drop",e=>{const file=e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0];if(!file)return;const dt=new DataTransfer();dt.items.add(file);input.files=dt.files;input.dispatchEvent(new Event("change"));});}
  }

  window.WPAYStatementParser={parseStatement};
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",bind);else bind();
})();
