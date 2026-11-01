// Recheck saved dispatch clues without blocking other supervisor events while a source is unavailable.
const {stillCurrent,releaseAnnounced}=require('./dispatch-audit.cjs');
function recheck(run,binding,state){
  for(const [id,event] of Object.entries(state.deferredDispatchEvents||{})){
    const result=stillCurrent(run,binding,state,event);
    if(result.current===null)continue;
    delete state.deferredDispatchEvents[id];
    if(result.current===false){
      releaseAnnounced(state,event);(state.resolved||={})[id]={event,obsolete:true};(state.seen||=[]).push(id);continue;
    }
    return event;
  }
  return null;
}
module.exports={recheck};
