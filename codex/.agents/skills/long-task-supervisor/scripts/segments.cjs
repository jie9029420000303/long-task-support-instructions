// The segment table of a run (Jay 2026-11-25): a segment is a group of related acceptance criteria and their
// dependencies. The executor's mainline loads one segment at a time, sends its packages to subagents, takes each delivery
// in, and submits the segment once all are adopted; the supervisor rules on that segment's criteria while the mainline
// starts the next. Before, the unit of review was a candidate grouped by scenario, code and test path, which did not map
// to criteria: 工區 E sent 122 submissions in 11/18～11/24 and had 1 of 45 criteria passed after 11 days.
// The supervisor writes the table (it knows the whole task); the mainline proposes changes by question. It is the
// supervisor's plan, not Jay's words, so it lives beside the locked contract instead of in its amendment journal.
'use strict';
const fs=require('node:fs'),path=require('node:path');
const FILE='segments.json';
const ID=/^[A-Za-z0-9_-]+$/;
const need=(ok,message)=>{if(!ok)throw Error(message);};
// Every criterion in scope belongs to exactly one segment; a segment depends only on other segments, without a cycle.
function validate(input,criterionIds){
  const segments=Array.isArray(input)?input:input?.segments;
  need(Array.isArray(segments)&&segments.length,'segments 至少要有一個區段');
  const ids=new Set(),owner=new Map(),known=new Set(criterionIds);
  for(const segment of segments){
    need(segment&&ID.test(segment.id||'')&&!ids.has(segment.id),'區段 ID 要唯一，只用英數字、底線或連字號：'+JSON.stringify(segment?.id));ids.add(segment.id);
    need(Array.isArray(segment.criteria)&&segment.criteria.length,'區段 '+segment.id+' 沒有列驗收條文');
    for(const id of segment.criteria){
      need(known.has(id),'區段 '+segment.id+' 列了有效契約裡沒有的條文：'+id);
      need(!owner.has(id),'條文 '+id+' 同時在區段 '+owner.get(id)+' 與 '+segment.id);owner.set(id,segment.id);
    }
    need(segment.dependsOn===undefined||Array.isArray(segment.dependsOn),'區段 '+segment.id+' 的 dependsOn 要是陣列');
  }
  const missing=[...known].filter(id=>!owner.has(id));
  need(!missing.length,'這些條文沒有分進任何區段：'+missing.join('、'));
  for(const segment of segments)for(const dep of segment.dependsOn||[])need(ids.has(dep)&&dep!==segment.id,'區段 '+segment.id+' 依賴不存在的區段：'+dep);
  const deps=new Map(segments.map(segment=>[segment.id,segment.dependsOn||[]])),done=new Set(),visiting=new Set();
  const visit=id=>{if(done.has(id))return;need(!visiting.has(id),'區段依賴形成循環：'+id);visiting.add(id);deps.get(id).forEach(visit);visiting.delete(id);done.add(id);};
  segments.forEach(segment=>visit(segment.id));
  return segments.map(segment=>({id:segment.id,...(segment.title?{title:String(segment.title)}:{}),criteria:[...segment.criteria],dependsOn:[...(segment.dependsOn||[])]}));
}
function read(run){
  const file=path.join(run,FILE);
  return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')).segments:null;
}
function write(run,input,criterionIds){
  const segments=validate(input,criterionIds),file=path.join(run,FILE);
  fs.writeFileSync(file+'.tmp',JSON.stringify({schemaVersion:1,updatedAt:new Date().toISOString(),segments},null,2)+'\n');
  fs.renameSync(file+'.tmp',file);
  return segments;
}
// Each segment with its criteria passed so far, from the acceptance items of the dispatch snapshot.
function progress(segments,items=[]){
  if(!segments)return null;
  const status=new Map(items.map(item=>[item.id,item.status]));
  return segments.map(segment=>({id:segment.id,...(segment.title?{title:segment.title}:{}),dependsOn:segment.dependsOn,criteria:segment.criteria,
    passed:segment.criteria.filter(id=>['PASS','EXCLUDED'].includes(status.get(id)))}));
}
module.exports={FILE,validate,read,write,progress};
