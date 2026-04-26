import type { Accessor, Component } from "solid-js";
import {
  buildLutFromPoints,
  curvePath,
  CURVE_MIN_X,
  normalizeInteriorPoint,
  normalizePoints,
  type ControlPoint,
} from "./curve-utils";
import { CurveEditorBase } from "./CurveEditorBase";

type CurvesEditorProps = {
  curvePointCache: Accessor<Map<number, ControlPoint[]>>;
  defaultCurvePoints: Accessor<ControlPoint[]>;
  onApplyCurves: (points: readonly ControlPoint[]) => Promise<unknown>;
  parameterRowClass: string;
};

export const CurvesEditor: Component<CurvesEditorProps> = (props) => (
  <CurveEditorBase
    label="Tone Curves"
    valueLabel=""
    parameterRowClass={props.parameterRowClass}
    curvePointCache={props.curvePointCache}
    defaultCurvePoints={props.defaultCurvePoints}
    getStoredPoints={(adjustments) => adjustments?.curves?.control_points}
    onApplyCurve={props.onApplyCurves}
    buildLut={buildLutFromPoints}
    normalizePoints={normalizePoints}
    normalizeInteriorPoint={normalizeInteriorPoint}
    buildSvgCurvePath={curvePath}
    yMax={1}
    endpointResetY={(point) => (point.x === CURVE_MIN_X ? 0 : 1)}
    showToneGuide={true}
  />
);
