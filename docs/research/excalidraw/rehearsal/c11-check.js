// docs/EXCALIDRAW-CUTOVER.md C11: the conversion check, verbatim (run inside the sync container: docker exec -i … node - < c11-check.js)
const fs=require('fs');const fin=JSON.parse(fs.readFileSync('/var/data/cutover/final-backups.json','utf8'));let bad=0;
for(const b of fin.boards){let r;try{r=JSON.parse(fs.readFileSync('/var/data/migration/'+b.boardId+'.json','utf8'))}catch{console.log('NO REPORT',b.boardId);bad++;continue}
const p=[];if(r.ok!==true)p.push('not converted: '+r.reason);if(r.ok&&r.sourceSha256!==b.recordsSha256)p.push('lb_source digest differs from the final backup');
if(r.sourceMatchesBackup===false)p.push('the sync says the digest differs');if((r.disk&&r.disk.ok)!==true)p.push('disk');
if(r.diff==null)p.push('no semantic diff');else if(r.diff.ok!==true)p.push('diff: '+r.diff.checks.filter(c=>c.pass!==true).map(c=>c.name+' '+c.failed).join(', '));
if(r.invariants!=='ran')p.push('invariants '+r.invariants);if(r.violations&&r.violations.length)p.push(r.violations.length+' invariant violations');
console.log(p.length?'FAIL':'ok  ',b.boardId,r.elementsOut+' elements',JSON.stringify(r.lossy),r.ms+' ms',r.peakHeapUsedMb+' MB',p.join('; '));if(p.length)bad++}
console.log(bad?bad+' board(s) failed: STOP':'all '+fin.boards.length+' boards converted and checked')
