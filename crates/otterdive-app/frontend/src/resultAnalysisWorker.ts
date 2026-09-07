import { analyseResults, type AnalysisStep, type ResultRow } from './resultAnalysis';
self.onmessage = (event: MessageEvent<{ rows: ResultRow[]; step: AnalysisStep }>) => {
  try { self.postMessage({ rows: analyseResults(event.data.rows, event.data.step) }); }
  catch (error) { self.postMessage({ error: String(error) }); }
};
