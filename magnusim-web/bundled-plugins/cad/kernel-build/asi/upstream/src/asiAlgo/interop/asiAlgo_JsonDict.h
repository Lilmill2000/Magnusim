//-----------------------------------------------------------------------------
// Created on: 29 October 2021
//-----------------------------------------------------------------------------
// Copyright (c) 2021-present, Sergey Slyadnev
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
//    * Redistributions of source code must retain the above copyright
//      notice, this list of conditions and the following disclaimer.
//    * Redistributions in binary form must reproduce the above copyright
//      notice, this list of conditions and the following disclaimer in the
//      documentation and/or other materials provided with the distribution.
//    * Neither the name of the copyright holder(s) nor the
//      names of all contributors may be used to endorse or promote products
//      derived from this software without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
// ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
// WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
// DISCLAIMED. IN NO EVENT SHALL THE AUTHORS OR CONTRIBUTORS BE LIABLE FOR ANY
// DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
// (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
// LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
// ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
// SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
//-----------------------------------------------------------------------------

#ifndef asiAlgo_JsonDict_HeaderFile
#define asiAlgo_JsonDict_HeaderFile

#include <asiAlgo.h>

// Filename extension.
#define asiRef_Ext "ref"

// Consts
#define asiPropVal_OS_Win                                 "win"
#define asiPropVal_OS_Lin                                 "lin"
#define asiPropVal_Type_Unrecognized                      "UNRECOGNIZED"
#define asiPropVal_Type_FlatShape                         "SHEET_METAL_FLAT"
#define asiPropVal_Type_FoldedSheetMetal                  "SHEET_METAL_FOLDED"
#define asiPropVal_Type_RectTube                          "TUBE_RECTANGULAR"
#define asiPropVal_Type_CylTube                           "TUBE_ROUND"
#define asiPropVal_Type_Wire                              "WIRE"
#define asiPropVal_Type_RoundBentTube                     "BENT_TUBE_ROUND"
#define asiPropVal_Type_RectangularBentTube               "BENT_TUBE_RECTANGULAR"
#define asiPropVal_Type_BentWire                          "BENT_WIRE"
#define asiPropVal_Type_Profile                           "PROFILE"
#define asiPropVal_Type_OtherTube                         "TUBE_OTHER"
#define asiPropVal_Type_CncMilling                        "CNC_MILLING"
#define asiPropVal_Type_CncLathe                          "CNC_LATHE"
#define asiPropVal_Type_CncLatheMilling                   "CNC_LATHE_MILLING"
#define asiPropVal_Type_Unknown                           "UNKNOWN"
#define asiPropVal_FuseAlgo_Boolean                       "boolean"
#define asiPropVal_FuseAlgo_Outliner                      "outliner"
#define asiPropVal_FuseAlgo_Clipper                       "clipper"

// Common props
#define asiPropName_Sdk                                   "sdk"
#define asiPropName_SdkVersion                            "sdkVersion"
#define asiPropName_SdkHash                               "sdkHash"
#define asiPropName_FileSizeBytes                         "fileSizeBytes"
#define asiPropName_ProcessingTime                        "processingTime"
#define asiPropName_ProcessingTimeCpu                     "processingTimeCpu"
#define asiPropName_UnitScaleFactor                       "unitScaleFactor"
#define asiPropName_OriginalUnitString                    "originalUnitString"
#define asiPropName_Bad                                   "bad"
#define asiPropName_Ignore                                "ignore"
#define asiPropName_File                                  "file"
#define asiPropName_Parts                                 "parts"
#define asiPropName_Id                                    "id"
#define asiPropName_Name                                  "name"
#define asiPropName_OriginalMaterial                      "originalMaterial"
#define asiPropName_Quantity                              "numOccurrences"
#define asiPropName_Bodies                                "bodies"
#define asiPropName_Type                                  "type"
#define asiPropName_AngleType                             "angleType"
#define asiPropName_Value                                 "value"
#define asiPropName_Volume                                "volume"
#define asiPropName_CuttingLength                         "cuttingLength"
#define asiPropName_NextSegment                           "nextSegment"
#define asiPropName_AngleToNextSegment                    "angleToNextSegment"
#define asiPropName_ConnectionPointToNextSegment          "connectionPointToNextSegment"
#define asiPropName_MiddlePointOfSegment                  "middlePoint"
#define asiPropName_Radius                                "radius"
#define asiPropName_Diameter                              "diameter"
#define asiPropName_Length                                "length"
#define asiPropName_Angle                                 "angle"
#define asiPropName_Segments                              "segments"
#define asiPropName_FaceId                                "faceId"
#define asiPropName_FaceIds                               "faceIds"
#define asiPropName_EdgeIds                               "edgeIds"
#define asiPropName_VertexIds                             "vertexIds"
#define asiPropName_Axis                                  "axis"
#define asiPropName_Hmin                                  "hmin"
#define asiPropName_Hmax                                  "hmax"
#define asiPropName_Umin                                  "umin"
#define asiPropName_Umax                                  "umax"
#define asiPropName_Vmin                                  "vmin"
#define asiPropName_Vmax                                  "vmax"
#define asiPropName_AABBDx                                "aabbDx"
#define asiPropName_AABBDy                                "aabbDy"
#define asiPropName_AABBDz                                "aabbDz"
#define asiPropName_AAG                                   "aag"
#define asiPropName_Code                                  "code"
#define asiPropName_Label                                 "label"
#define asiPropName_Warnings                              "warnings"
#define asiPropName_StatusCodes                           "codes"
#define asiPropName_SemanticCodes                         "semanticCodes"
#define asiPropName_Naming                                "naming"
#define asiPropName_FaceLocations                         "faceLocations"
#define asiPropName_BlendChains                            "blendChains"
#define asiPropName_CrossEdgeLength                       "crossEdgeLength"
#define asiPropName_Holes                                 "holes"
#define asiPropName_Shafts                                "shafts"
#define asiPropName_Cavities                              "cavities"
#define asiPropName_BaseFaceIds                           "baseFaceIds"
#define asiPropName_BaseFaces                             "baseFaces"
#define asiPropName_ConvexHull                            "convexHull"
#define asiPropName_Probes                                "probes"
#define asiPropName_ProbePoint                            "probePoint"
#define asiPropName_OutlineIsClosed                       "isClosed"
#define asiPropName_OutlineNbEdges                        "nbEdges"
#define asiPropName_GeometryHash                          "geometryHash"

// Extras
#define asiPropName_ExtrasCanRecSummary                   "canrecSummary"
#define asiPropName_ExtrasCanRecSurfBezier                "nbSurfBezier"
#define asiPropName_ExtrasCanRecSurfSpl                   "nbSurfSpl"
#define asiPropName_ExtrasCanRecSurfConical               "nbSurfConical"
#define asiPropName_ExtrasCanRecSurfCyl                   "nbSurfCyl"
#define asiPropName_ExtrasCanRecSurfOffset                "nbSurfOffset"
#define asiPropName_ExtrasCanRecSurfSph                   "nbSurfSph"
#define asiPropName_ExtrasCanRecSurfLinExtr               "nbSurfLinExtr"
#define asiPropName_ExtrasCanRecSurfOfRevol               "nbSurfOfRevol"
#define asiPropName_ExtrasCanRecSurfToroidal              "nbSurfToroidal"
#define asiPropName_ExtrasCanRecSurfPlane                 "nbSurfPlane"
#define asiPropName_ExtrasCanRecCurveBezier               "nbCurveBezier"
#define asiPropName_ExtrasCanRecCurveSpline               "nbCurveSpline"
#define asiPropName_ExtrasCanRecCurveCircle               "nbCurveCircle"
#define asiPropName_ExtrasCanRecCurveEllipse              "nbCurveEllipse"
#define asiPropName_ExtrasCanRecCurveHyperbola            "nbCurveHyperbola"
#define asiPropName_ExtrasCanRecCurveLine                 "nbCurveLine"
#define asiPropName_ExtrasCanRecCurveOffset               "nbCurveOffset"
#define asiPropName_ExtrasCanRecCurveParabola             "nbCurveParabola"
#define asiPropName_ExtrasCanRecIsValid                   "isValidAfterConversion"

// Scene tree
#define asiPropName_SceneTree           "sceneTree"
#define asiPropName_SceneRoots          "roots"
#define asiPropName_ScenePrototypes     "prototypes"
#define asiPropName_SceneId             "id"
#define asiPropName_SceneName           "name"
#define asiPropName_SceneAssemblies     "assemblies"
#define asiPropName_SceneChildInstances "childInstances"
#define asiPropName_SceneInstances      "instances"
#define asiPropName_ScenePrototype      "prototype"
#define asiPropName_SceneAssemblyItemId "assemblyItemId"
#define asiPropName_SceneRotation       "rotation"
#define asiPropName_SceneTranslation    "translation"
#define asiPropName_SceneParts          "parts"
#define asiPropName_ScenePersistentId   "persistentId"
#define asiPropName_SceneShape          "shape"

#endif
