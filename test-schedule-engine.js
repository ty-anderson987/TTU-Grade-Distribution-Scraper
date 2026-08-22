const assert = require('assert');
const {
  normalizeCourseCode,
  timeToMinutes,
  instructorKey,
  analyzeSchedules,
  optionsConflict,
  professorForOption,
  professorGradeForOption,
  buildGradeSummary,
  forecastProfessorGpa,
  optionIsHonors,
  optionDeliveryMode,
  rmpFallbackScore
} = require('./schedule-engine');

function comp(section, instructor, days, start, end, extra={}) {
  return {
    courseCode: extra.courseCode || '', section, instructor, crn: extra.crn || '',
    credits: extra.credits ?? 3, status: extra.status || 'open', online: Boolean(extra.online),
    meetings: days ? [{ days, start, end }] : [], ...extra
  };
}

// Flexible course-code normalization stays strict to a real subject + catalog number.
assert.strictEqual(normalizeCourseCode('ece-3311'), 'ECE 3311');
assert.strictEqual(normalizeCourseCode(' MATH1452 '), 'MATH 1452');
assert.strictEqual(normalizeCourseCode('not a course'), null);
assert.strictEqual(timeToMinutes('12:00 AM'), 0);
assert.strictEqual(timeToMinutes('12:00 PM'), 720);
assert.strictEqual(timeToMinutes('23:59'), 1439);
assert.strictEqual(timeToMinutes('13:00 PM'), null, 'invalid 12-hour clock values must be rejected');
assert.strictEqual(timeToMinutes('25:99'), null, 'invalid 24-hour clock values must be rejected');


// A lecture + lab/discussion result is one atomic option. The analyzer must never split it.
const linked = {
  courseCode: 'CHEM 1307', optionKey: '10001+10002', occurrenceCoverageComplete: true,
  components: [
    comp('Lec 001','Professor A',['M','W','F'],'9:00 AM','9:50 AM',{courseCode:'CHEM 1307',crn:'10001',credits:4}),
    comp('Lab 501','TA One',['T'],'2:00 PM','4:50 PM',{courseCode:'CHEM 1307',crn:'10002',credits:0})
  ],
  occurrences: [
    {date:'2026-09-07',day:'M',start:'9:00 AM',end:'9:50 AM',kind:'Lecture'},
    {date:'2026-09-08',day:'T',start:'2:00 PM',end:'4:50 PM',kind:'Laboratory'},
    {date:'2026-09-09',day:'W',start:'9:00 AM',end:'9:50 AM',kind:'Lecture'},
    {date:'2026-09-11',day:'F',start:'9:00 AM',end:'9:50 AM',kind:'Lecture'}
  ], weeks:[{weekStart:'2026-09-06',label:'September 6 - September 12, 2026'}]
};
const second = {
  courseCode:'ENGL 1301', optionKey:'20001', occurrenceCoverageComplete:true,
  components:[comp('Lec 002','Professor B',['T','R'],'11:00 AM','12:20 PM',{courseCode:'ENGL 1301',crn:'20001',credits:3})],
  occurrences:[
    {date:'2026-09-08',day:'T',start:'11:00 AM',end:'12:20 PM',kind:'Lecture'},
    {date:'2026-09-10',day:'R',start:'11:00 AM',end:'12:20 PM',kind:'Lecture'}
  ], weeks:[{weekStart:'2026-09-06',label:'September 6 - September 12, 2026'}]
};
const analysis = analyzeSchedules([
  {courseCode:'CHEM 1307', options:[linked], gradeHistory:{rows:[]}, preferences:{professorPriority:3,delivery:'either',professors:{}}},
  {courseCode:'ENGL 1301', options:[second], gradeHistory:{rows:[]}, preferences:{professorPriority:3,delivery:'either',professors:{}}}
], {gradeWeight:50});
assert.strictEqual(analysis.totalMatching, 1);
const chemOut = analysis.schedules[0].courses.find(c=>c.courseCode==='CHEM 1307');
assert.strictEqual(chemOut.components.length, 2, 'linked lecture/lab components must remain together');
assert.strictEqual(chemOut.linkedBundle, true);
assert.strictEqual(chemOut.credits, 4, 'linked component credits must not double-count');


// Alternative linked bundles must remain intact; the engine must never cross-pair a
// lecture from one VSB timetable result with a lab/discussion from another result.
const linkedAlt = {
  courseCode: 'CHEM 1307', optionKey: '11001+11002', occurrenceCoverageComplete:false,
  components: [
    comp('Lec 002','Professor B',['T','R'],'9:30 AM','10:50 AM',{courseCode:'CHEM 1307',crn:'11001',credits:4}),
    comp('Lab 502','TA Two',['W'],'2:00 PM','4:50 PM',{courseCode:'CHEM 1307',crn:'11002',credits:0})
  ]
};
const bundleAnalysis = analyzeSchedules([
  {courseCode:'CHEM 1307', options:[linked, linkedAlt], gradeHistory:{rows:[]}, preferences:{professorPriority:3,delivery:'either',professors:{}}}
], {gradeWeight:50});
assert.strictEqual(bundleAnalysis.totalMatching, 2);
for (const schedule of bundleAnalysis.schedules) {
  const chem = schedule.courses.find(c => c.courseCode === 'CHEM 1307');
  const crns = chem.components.map(c => c.crn).sort().join('+');
  assert.ok(['10001+10002','11001+11002'].includes(crns), 'linked VSB rows must never be cross-paired');
}

// Alternating labs at the same clock time are allowed only when full-term exact coverage is verified.
const labA = {courseCode:'BIOL 1101', optionKey:'a', occurrenceCoverageComplete:true, components:[comp('Lab 001','TA A',['T'],'2:00 PM','4:00 PM')], occurrences:[{date:'2026-09-08',day:'T',start:'2:00 PM',end:'4:00 PM',kind:'Laboratory'}]};
const labB = {courseCode:'CHEM 1101', optionKey:'b', occurrenceCoverageComplete:true, components:[comp('Lab 001','TA B',['T'],'2:00 PM','4:00 PM')], occurrences:[{date:'2026-09-15',day:'T',start:'2:00 PM',end:'4:00 PM',kind:'Laboratory'}]};
assert.strictEqual(optionsConflict(labA, labB), false, 'verified alternating-week labs should coexist');
const labBPartial = {...labB, occurrenceCoverageComplete:false};
assert.strictEqual(optionsConflict(labA, labBPartial), true, 'partial week capture must fall back conservatively');

// One-off discussion/test periods must block another course on the exact date.
const courseWithExam = {
  courseCode:'CE 2301', optionKey:'ce', occurrenceCoverageComplete:true,
  components:[comp('Lec 001','Professor C',['M','W','F'],'8:00 AM','8:50 AM')],
  occurrences:[
    {date:'2026-09-07',day:'M',start:'8:00 AM',end:'8:50 AM',kind:'Lecture'},
    {date:'2026-09-10',day:'R',start:'6:00 PM',end:'7:00 PM',kind:'Test',special:true}
  ]
};
const thursday = {
  courseCode:'MATH 1452', optionKey:'math', occurrenceCoverageComplete:true,
  components:[comp('Lec 001','Professor D',['R'],'6:30 PM','7:30 PM')],
  occurrences:[{date:'2026-09-10',day:'R',start:'6:30 PM',end:'7:30 PM',kind:'Lecture'}]
};
assert.strictEqual(optionsConflict(courseWithExam, thursday), true, 'one-off test/discussion conflicts must be honored');

// Lecture instructor is the primary professor for grade scoring when a lab TA is also named.
assert.strictEqual(professorForOption(linked), 'Professor A');
const history = buildGradeSummary({rows:[
  {rowType:'data', instructor:'Professor A', term:'Spring 2026', A:30,B:20,C:10,D:2,F:1,W:1},
  {rowType:'data', instructor:'TA One', term:'Spring 2026', A:0,B:0,C:1,D:10,F:20,W:0}
]});
assert.strictEqual(professorGradeForOption(linked, history).name, 'Professor A');

const taOnlyHistory = buildGradeSummary({rows:[
  {rowType:'data', instructor:'TA One', term:'Spring 2026', A:0,B:0,C:1,D:10,F:20,W:0}
]});
assert.strictEqual(professorGradeForOption(linked, taOnlyHistory), null, 'lab/discussion assistant history must not replace missing lecture-instructor history');

// Synchronous online meetings still block time, but they do not add a campus day.
const online = {
  courseCode:'PHIL 2300', optionKey:'on', occurrenceCoverageComplete:false,
  components:[comp('Lec D01','Professor Online',['M','W'],'10:00 AM','10:50 AM',{courseCode:'PHIL 2300',crn:'30001',credits:3,online:true})]
};
const onAnalysis = analyzeSchedules([
  {courseCode:'PHIL 2300', options:[online], gradeHistory:{rows:[]}, preferences:{professorPriority:3,delivery:'online',professors:{}}}
], {gradeWeight:50});
assert.strictEqual(onAnalysis.schedules[0].daysOnCampus, 0);

const exactHybrid = {
  courseCode:'ENGR 2000', optionKey:'exact-hybrid', occurrenceCoverageComplete:true,
  components:[
    comp('Lec 001','Professor Hybrid',['M'],'9:00 AM','9:50 AM',{courseCode:'ENGR 2000',online:false}),
    comp('Dis D01','Professor Hybrid',['W'],'7:00 PM','7:50 PM',{courseCode:'ENGR 2000',online:true})
  ],
  occurrences:[
    {date:'2026-09-07',day:'M',start:'9:00 AM',end:'9:50 AM',kind:'Lecture',online:false},
    {date:'2026-09-09',day:'W',start:'7:00 PM',end:'7:50 PM',kind:'Discussion',online:true}
  ]
};
const exactHybridAnalysis = analyzeSchedules([
  {courseCode:'ENGR 2000', options:[exactHybrid], gradeHistory:{rows:[]}, preferences:{professorPriority:3,delivery:'either',professors:{}}}
], {});
assert.strictEqual(exactHybridAnalysis.schedules[0].daysOnCampus, 1, 'verified online discussion must not create an extra campus day');

// Avoid is a hard filter and Prefer is only a ranking boost; linked assistants stay attached.
const choiceA = {courseCode:'MATH 1452', optionKey:'pa', components:[comp('Lec 001','Good Prof',['M','W'],'1:00 PM','2:20 PM',{courseCode:'MATH 1452',crn:'41001'})]};
const choiceB = {courseCode:'MATH 1452', optionKey:'pb', components:[comp('Lec 002','Avoid Prof',['T','R'],'1:00 PM','2:20 PM',{courseCode:'MATH 1452',crn:'41002'})]};
const avoidAnalysis = analyzeSchedules([
  {courseCode:'MATH 1452', options:[choiceA,choiceB], gradeHistory:{rows:[]}, preferences:{professorPriority:5,delivery:'either',professors:{'avoid prof':'avoid'}}}
], {gradeWeight:50});
assert.strictEqual(avoidAnalysis.totalMatching, 1);
assert.strictEqual(avoidAnalysis.schedules[0].courses[0].optionKey, 'pa');

// A required zero-credit online companion lab does not turn the main in-person
// lecture into an "online" section. The lab time still remains in the atomic bundle.
const noCreditBundle = {courseCode:'ENGR 1330', optionKey:'19320+19360', components:[
  comp('Lec 005','Arca, Sevgi',['M','W','F'],'4:00 PM','4:50 PM',{courseCode:'ENGR 1330',crn:'19320',credits:3,online:false}),
  comp('No Credit D55','Arca, Sevgi',['M','W'],'5:00 PM','5:50 PM',{courseCode:'ENGR 1330',crn:'19360',credits:0,online:true})
]};
assert.strictEqual(optionDeliveryMode(noCreditBundle), 'in-person');
const inPersonOnly = analyzeSchedules([
  {courseCode:'ENGR 1330', options:[noCreditBundle], gradeHistory:{rows:[]}, preferences:{professorPriority:3,delivery:'in-person',professors:{}}}
], {});
assert.strictEqual(inPersonOnly.totalMatching, 1);
assert.deepStrictEqual(inPersonOnly.schedules[0].courses[0].components.map(c=>c.crn).sort(), ['19320','19360']);
assert.strictEqual(inPersonOnly.schedules[0].totalCredits, 3);


// Zero-credit companion meetings are still real time conflicts and their CRNs stay locked.
const overlapWithNoCredit = {courseCode:'MATH 9999', optionKey:'overlap', components:[
  comp('Lec 001','Professor X',['M'],'5:30 PM','6:20 PM',{courseCode:'MATH 9999',crn:'60001',credits:3,online:false})
]};
assert.strictEqual(optionsConflict(noCreditBundle, overlapWithNoCredit), true, '0-credit companion meeting time must block overlapping courses');

// Same-time VSB alternatives remain separate atomic CRN bundles so professor choices
// can select one without merging its no-credit companion with another section.
const noCreditAlt = {courseCode:'ENGR 1330', optionKey:'19321+19361', components:[
  comp('Lec 006','Ghamkhari, Seyed Mahdi',['M','W','F'],'4:00 PM','4:50 PM',{courseCode:'ENGR 1330',crn:'19321',credits:3,online:false}),
  comp('No Credit D56','Ghamkhari, Seyed Mahdi',['M','W'],'5:00 PM','5:50 PM',{courseCode:'ENGR 1330',crn:'19361',credits:0,online:true})
]};
const altProfessorAnalysis = analyzeSchedules([
  {courseCode:'ENGR 1330', options:[noCreditBundle,noCreditAlt], gradeHistory:{rows:[]}, preferences:{professorPriority:3,delivery:'either',professors:{'ghamkhari, seyed mahdi':'avoid'}}}
], {});
assert.strictEqual(altProfessorAnalysis.totalMatching, 1);
assert.deepStrictEqual(altProfessorAnalysis.schedules[0].courses[0].components.map(c=>c.crn).sort(), ['19320','19360']);

// A genuinely online main section is still excluded by an in-person requirement.
const onlineMain = {courseCode:'ENGR 1330', optionKey:'online-main', components:[
  comp('Lec D01','Professor Online',['M'],'4:00 PM','4:50 PM',{courseCode:'ENGR 1330',crn:'50001',credits:3,online:true}),
  comp('No Credit D01','Professor Online',['W'],'5:00 PM','5:50 PM',{courseCode:'ENGR 1330',crn:'50002',credits:0,online:true})
]};
const onlineRejected = analyzeSchedules([
  {courseCode:'ENGR 1330', options:[onlineMain], gradeHistory:{rows:[]}, preferences:{professorPriority:3,delivery:'in-person',professors:{}}}
], {});
assert.strictEqual(onlineRejected.totalMatching, 0);

// Professor availability must reflect the full matching schedule set under active
// time constraints, so the UI can dim professors whose sections are impossible.
const earlyProf = {courseCode:'TEST 1000', optionKey:'early', components:[comp('Lec 001','Early Prof',['M'],'8:00 AM','8:50 AM',{courseCode:'TEST 1000'})]};
const lateProf = {courseCode:'TEST 1000', optionKey:'late', components:[comp('Lec 002','Late Prof',['M'],'11:00 AM','11:50 AM',{courseCode:'TEST 1000'})]};
const availabilityAnalysis = analyzeSchedules([
  {courseCode:'TEST 1000', options:[earlyProf,lateProf], gradeHistory:{rows:[]}, preferences:{professorPriority:3,delivery:'either',professors:{}}}
], {earliestStart:600});
assert.strictEqual(availabilityAnalysis.professorAvailability['TEST 1000'][instructorKey('Early Prof')] || 0, 0, 'time-filtered professor should have zero compatible schedules');
assert.strictEqual(availabilityAnalysis.professorAvailability['TEST 1000'][instructorKey('Late Prof')], 1, 'available professor should report matching schedule count');

// Overlapping/nested components on one day form a single occupied block for gap
// scoring. A short nested component must not invent a fake long break or shorten the
// day's true end time.
const nestedGapOption = {courseCode:'NEST 1000', optionKey:'nested-gap', components:[
  comp('Lec 001','P',['M'],'9:00 AM','12:00 PM',{courseCode:'NEST 1000'}),
  comp('Lab 001','P',['M'],'10:00 AM','11:00 AM',{courseCode:'NEST 1000',credits:0}),
  comp('Dis 001','P',['M'],'12:30 PM','1:00 PM',{courseCode:'NEST 1000',credits:0})
]};
const nestedGapAnalysis = analyzeSchedules([
  {courseCode:'NEST 1000', options:[nestedGapOption], gradeHistory:{rows:[]}, preferences:{professorPriority:3,delivery:'either',professors:{}}}
], {maxGap:60, latestEnd:12*60+45});
assert.strictEqual(nestedGapAnalysis.totalMatching, 0, 'latest-end must use the actual latest meeting end even with nested meetings');
const nestedGapAllowed = analyzeSchedules([
  {courseCode:'NEST 1000', options:[nestedGapOption], gradeHistory:{rows:[]}, preferences:{professorPriority:3,delivery:'either',professors:{}}}
], {maxGap:60, latestEnd:13*60});
assert.strictEqual(nestedGapAllowed.totalMatching, 1, 'true 30-minute gap must pass a 60-minute max-gap filter');
assert.strictEqual(nestedGapAllowed.schedules[0].maxGap, 30);

// Compact analysis must preserve the same ranked choice without duplicating the
// full timetable payload inside every schedule row.
const compactAnalysis = analyzeSchedules([
  {courseCode:'ENGR 1330', options:[noCreditBundle,noCreditAlt], gradeHistory:{rows:[]}, preferences:{professorPriority:3,delivery:'either',professors:{'ghamkhari, seyed mahdi':'avoid'}}}
], {}, {compact:true, topLimit:50});
assert.strictEqual(compactAnalysis.compact, true);
assert.strictEqual(compactAnalysis.schedules[0].courseRefs[0].optionKey, '19320+19360');
assert.deepStrictEqual(compactAnalysis.optionCatalog['ENGR 1330']['19320+19360'].components.map(c=>c.crn).sort(), ['19320','19360']);
assert.ok(!('courses' in compactAnalysis.schedules[0]), 'compact schedules should reference shared option data instead of duplicating it');


// TTU honors filtering is based on the lecture section convention "Lec H###".
const honorsOption = {
  courseCode:'MATH 1451', optionKey:'honors',
  components:[comp('Lec H01','Honors Prof',['M','W','F'],'10:00 AM','10:50 AM',{courseCode:'MATH 1451',crn:'70001'})]
};
const regularOption = {
  courseCode:'MATH 1451', optionKey:'regular',
  components:[comp('Lec 001','Regular Prof',['M','W','F'],'11:00 AM','11:50 AM',{courseCode:'MATH 1451',crn:'70002'})]
};
assert.strictEqual(optionIsHonors(honorsOption), true);
assert.strictEqual(optionIsHonors(regularOption), false);
const honorsLinked={courseCode:'MATH 1451',optionKey:'honors-linked',components:[
  comp('Lec H02','Honors Prof',['T','R'],'9:30 AM','10:50 AM',{courseCode:'MATH 1451',credits:3}),
  comp('No Credit D02','Lab TA',['F'],'2:00 PM','2:50 PM',{courseCode:'MATH 1451',credits:0,online:true})
]};
assert.strictEqual(optionIsHonors(honorsLinked), true,'linked no-credit component must not erase Lec H### honors identity');
const honorsOnlyAnalysis = analyzeSchedules([
  {courseCode:'MATH 1451', options:[honorsOption,regularOption], gradeHistory:{rows:[]}, preferences:{professorPriority:3,delivery:'either',professors:{}}}
], {honorsMode:'only'});
assert.strictEqual(honorsOnlyAnalysis.totalMatching, 1);
assert.strictEqual(honorsOnlyAnalysis.schedules[0].courses[0].optionKey, 'honors');
const regularOnlyAnalysis = analyzeSchedules([
  {courseCode:'MATH 1451', options:[honorsOption,regularOption], gradeHistory:{rows:[]}, preferences:{professorPriority:3,delivery:'either',professors:{}}}
], {honorsMode:'exclude'});
assert.strictEqual(regularOnlyAnalysis.totalMatching, 1);
assert.strictEqual(regularOnlyAnalysis.schedules[0].courses[0].optionKey, 'regular');

// Semester forecast: at least three historical terms are required, and an improving
// course-specific history should produce a bounded future aggregate-GPA estimate.
const forecastHistory = buildGradeSummary({rows:[
  {rowType:'data', instructor:'Trend Prof', term:'Fall 2024', A:20,B:20,C:10,D:5,F:5,W:0},
  {rowType:'data', instructor:'Trend Prof', term:'Spring 2025', A:25,B:22,C:8,D:3,F:2,W:0},
  {rowType:'data', instructor:'Trend Prof', term:'Fall 2025', A:30,B:22,C:6,D:1,F:1,W:0},
  {rowType:'data', instructor:'Trend Prof', term:'Spring 2026', A:34,B:20,C:4,D:1,F:1,W:0}
]}, 'Fall 2026');
const forecastProf = Object.values(forecastHistory.professors)[0];
assert.ok(Number.isFinite(forecastProf.predictedGpa));
assert.ok(forecastProf.predictedGpa >= 0 && forecastProf.predictedGpa <= 4);
assert.ok(['low','medium','high'].includes(forecastProf.predictionConfidence));
assert.ok(forecastProf.predictionLow <= forecastProf.predictedGpa && forecastProf.predictionHigh >= forecastProf.predictedGpa);
const insufficientForecast = forecastProfessorGpa([{term:'Spring 2026',gpa:3.2,students:40}], 'Fall 2026', 3.1);
assert.strictEqual(insufficientForecast.predictedGpa, null);

// Live time-filter grid must be exact when the combination search completes. These
// two one-course options make the expected counts easy to verify without rerunning.
const morning = {courseCode:'TEST 1000',optionKey:'morning',components:[comp('Lec 001','P',['M'],'9:00 AM','9:50 AM',{courseCode:'TEST 1000'})]};
const late = {courseCode:'TEST 1000',optionKey:'late',components:[comp('Lec 002','P',['M'],'11:00 AM','11:50 AM',{courseCode:'TEST 1000'})]};
const gridAnalysis = analyzeSchedules([
  {courseCode:'TEST 1000',options:[morning,late],gradeHistory:{rows:[]},preferences:{professorPriority:3,delivery:'either',professors:{}}}
], {}, {compact:true});
assert.strictEqual(gridAnalysis.constraintGrid.complete, true);
function gridCount(result, earliest=null, latest=null, maxGap=null, noFriday=false) {
  const g=result.constraintGrid;
  const ei=g.earliest.findIndex(v=>v===earliest),li=g.latest.findIndex(v=>v===latest),gi=g.maxGap.findIndex(v=>v===maxGap),fi=noFriday?1:0;
  return g.counts[(((ei*g.latest.length)+li)*g.maxGap.length+gi)*2+fi];
}
assert.strictEqual(gridCount(gridAnalysis,null,null,null,false),2);
assert.strictEqual(gridCount(gridAnalysis,600,null,null,false),1,'10 AM or later should leave only the 11 AM option');
assert.strictEqual(gridCount(gridAnalysis,720,null,null,false),0,'noon or later should be known impossible before update');

const evening = {courseCode:'TEST 2000',optionKey:'evening',components:[comp('Lec 001','P',['F'],'6:00 PM','7:15 PM',{courseCode:'TEST 2000'})]};
const daytime = {courseCode:'TEST 2000',optionKey:'daytime',components:[comp('Lec 002','P',['T'],'1:00 PM','1:50 PM',{courseCode:'TEST 2000'})]};
const latestGrid = analyzeSchedules([
  {courseCode:'TEST 2000',options:[evening,daytime],gradeHistory:{rows:[]},preferences:{professorPriority:3,delivery:'either',professors:{}}}
], {}, {compact:true});
assert.strictEqual(gridCount(latestGrid,null,1020,null,false),1,'ending by 5 PM should exclude the evening section');
assert.strictEqual(gridCount(latestGrid,null,null,null,true),1,'No Friday should exclude the Friday evening option');

// If the conflict-free search hits its safety cap, live availability is only a
// lower bound. The browser must not disable a zero-result filter as impossible.
const manyA=Array.from({length:40},(_,i)=>({courseCode:'CAP 1000',optionKey:`a${i}`,components:[{courseCode:'CAP 1000',section:`Lec ${i}`,instructor:'P',crn:`8${String(i).padStart(4,'0')}`,credits:3,meetings:[]}]}));
const manyB=Array.from({length:40},(_,i)=>({courseCode:'CAP 2000',optionKey:`b${i}`,components:[{courseCode:'CAP 2000',section:`Lec ${i}`,instructor:'Q',crn:`9${String(i).padStart(4,'0')}`,credits:3,meetings:[]}]}));
const truncatedGrid = analyzeSchedules([
  {courseCode:'CAP 1000',options:manyA,gradeHistory:{rows:[]},preferences:{professorPriority:3,delivery:'either',professors:{}}},
  {courseCode:'CAP 2000',options:manyB,gradeHistory:{rows:[]},preferences:{professorPriority:3,delivery:'either',professors:{}}}
], {}, {compact:true,maxSchedules:1000});
assert.strictEqual(truncatedGrid.truncated, true);
assert.strictEqual(truncatedGrid.constraintGrid.complete, false);


// Malformed direct-API options must not disable the combination safety cap or poison
// the live constraint grid. Browser UI calls already send numbers, but the local API
// should remain fail-safe when given strings or invalid values.
const stringPrefAnalysis = analyzeSchedules([
  {courseCode:'TEST 1000',options:[morning,late],gradeHistory:{rows:[]},preferences:{professorPriority:3,delivery:'either',professors:{}}}
], {earliestStart:'600', latestEnd:'1440', maxGap:'60', dayPreference:'NOT-A-MODE', gradeWeight:'999'}, {compact:true,maxSchedules:'not-a-number',topLimit:'not-a-number'});
assert.strictEqual(stringPrefAnalysis.totalMatching,1,'numeric-string time preferences should normalize consistently');
assert.strictEqual(gridCount(stringPrefAnalysis,600,null,null,false),1,'normalized preferences must remain compatible with the live constraint grid');
const invalidPrefAnalysis = analyzeSchedules([
  {courseCode:'TEST 1000',options:[morning,late],gradeHistory:{rows:[]},preferences:{professorPriority:3,delivery:'either',professors:{}}}
], {earliestStart:'garbage', latestEnd:99999, maxGap:-5}, {compact:true,maxSchedules:NaN,topLimit:NaN});
assert.strictEqual(invalidPrefAnalysis.totalMatching,2,'invalid time preferences should safely fall back to unconstrained values');

// Professor-ranking source hierarchy: TTU grade distribution wins whenever it exists;
// RMP is only a fallback; with neither source, schedule convenience decides.
const gradeProfOption={courseCode:'RANK 1000',optionKey:'grade-prof',components:[comp('Lec 001','Grade Prof',['M'],'10:00 AM','10:50 AM',{courseCode:'RANK 1000'})]};
const rmpProfOption={courseCode:'RANK 1000',optionKey:'rmp-prof',components:[comp('Lec 002','RMP Prof',['M'],'10:00 AM','10:50 AM',{courseCode:'RANK 1000'})]};
const sourceHierarchy=analyzeSchedules([{
  courseCode:'RANK 1000',
  options:[gradeProfOption,rmpProfOption],
  gradeHistory:{rows:[{rowType:'data',instructor:'Grade Prof',term:'Spring 2026',A:0,B:0,C:0,D:0,F:100,W:0}]},
  rmpByProfessor:{
    [instructorKey('Grade Prof')]:{status:'success',avgRating:5,numRatings:200},
    [instructorKey('RMP Prof')]:{status:'success',avgRating:4.5,numRatings:200}
  },
  preferences:{professorPriority:3,delivery:'either',professors:{}}
}],{gradeWeight:100});
assert.strictEqual(sourceHierarchy.schedules[0].courses[0].optionKey,'rmp-prof','a professor with TTU history must be scored from TTU data even if their RMP score is higher');
assert.strictEqual(sourceHierarchy.schedules[0].courses[0].rankingSignal.source,'rmp');
const gradeChoice=sourceHierarchy.schedules.find(x=>x.courses[0].optionKey==='grade-prof').courses[0];
assert.strictEqual(gradeChoice.rankingSignal.source,'ttu-grade','TTU history must take precedence over RMP for the same professor');

const highRmp={courseCode:'RANK 2000',optionKey:'high-rmp',components:[comp('Lec 001','High RMP',['T'],'10:00 AM','10:50 AM',{courseCode:'RANK 2000'})]};
const lowRmp={courseCode:'RANK 2000',optionKey:'low-rmp',components:[comp('Lec 002','Low RMP',['T'],'10:00 AM','10:50 AM',{courseCode:'RANK 2000'})]};
const rmpFallback=analyzeSchedules([{
  courseCode:'RANK 2000',options:[lowRmp,highRmp],gradeHistory:{rows:[]},
  rmpByProfessor:{
    [instructorKey('High RMP')]:{status:'success',avgRating:4.8,numRatings:80},
    [instructorKey('Low RMP')]:{status:'success',avgRating:2.2,numRatings:80}
  },preferences:{professorPriority:3,delivery:'either',professors:{}}
}],{gradeWeight:100});
assert.strictEqual(rmpFallback.schedules[0].courses[0].optionKey,'high-rmp','RMP should rank professors only when TTU history is unavailable');
assert.ok(rmpFallback.schedules[0].professorScoreAvailable);
assert.ok(rmpFallbackScore({avgRating:5,numRatings:100})>rmpFallbackScore({avgRating:5,numRatings:1}),'tiny RMP samples must be shrunk toward neutral');
assert.strictEqual(rmpFallbackScore({avgRating:0,numRatings:0}),null,'an unrated RMP profile must contribute no ranking score');
assert.strictEqual(rmpFallbackScore({avgRating:0,numRatings:12}),null,'0/5 is not a valid RMP rating and must never lower a professor ranking');

const compactOption={courseCode:'RANK 3000',optionKey:'compact',components:[comp('Lec 001','No Data A',['T','R'],'10:00 AM','10:50 AM',{courseCode:'RANK 3000'})]};
const spreadOption={courseCode:'RANK 3000',optionKey:'spread',components:[comp('Lec 002','No Data B',['M','W','F'],'10:00 AM','10:50 AM',{courseCode:'RANK 3000'})]};
const noProfessorData=analyzeSchedules([{
  courseCode:'RANK 3000',options:[spreadOption,compactOption],gradeHistory:{rows:[]},rmpByProfessor:{},
  preferences:{professorPriority:3,delivery:'either',professors:{}}
}],{gradeWeight:100,dayPreference:'few-days'});
assert.strictEqual(noProfessorData.schedules[0].courses[0].optionKey,'compact','with neither TTU nor RMP data, schedule convenience must decide even at 100% professor-data weight');
assert.strictEqual(noProfessorData.schedules[0].professorScoreAvailable,false);
assert.strictEqual(noProfessorData.schedules[0].courses[0].rankingSignal.source,'none');

console.log('schedule-engine regression tests passed');
