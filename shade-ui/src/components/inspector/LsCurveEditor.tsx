import type { Accessor, Component } from "solid-js";
import {
  buildLsCurveLutFromPoints,
  lsCurvePath,
  normalizeLsInteriorPoint,
  normalizeLsPoints,
  type ControlPoint,
} from "./curve-utils";
import { CurveEditorBase } from "./CurveEditorBase";

type LsCurveEditorProps = {
  lsCurvePointCache: Accessor<Map<number, ControlPoint[]>>;
  defaultLsCurvePoints: Accessor<ControlPoint[]>;
  onApplyLsCurve: (points: readonly ControlPoint[]) => Promise<unknown>;
  parameterRowClass: string;
};

export const LsCurveEditor: Component<LsCurveEditorProps> = (props) => (
  <CurveEditorBase
    label="Luminance vs Saturation"
    valueLabel=""
    parameterRowClass={props.parameterRowClass}
    curvePointCache={props.lsCurvePointCache}
    defaultCurvePoints={props.defaultLsCurvePoints}
    getStoredPoints={(adjustments) => adjustments?.ls_curve?.control_points}
    onApplyCurve={props.onApplyLsCurve}
    buildLut={buildLsCurveLutFromPoints}
    normalizePoints={normalizeLsPoints}
    normalizeInteriorPoint={normalizeLsInteriorPoint}
    buildSvgCurvePath={lsCurvePath}
    yMax={2}
    endpointResetY={() => 1}
    bottomLabels={["Lum", "Sat"]}
  />
);
