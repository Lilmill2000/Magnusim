//-----------------------------------------------------------------------------
// Copyright (c) 2017-present, Sergey Slyadnev
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

// Own include
#include <asiAlgo_FindFeatureHints.h>

// asiAlgo includes
#include <asiAlgo_CheckValidity.h>
#include <asiAlgo_Utils.h>

// OCCT includes
#include <BRep_Tool.hxx>
#include <BRepTools.hxx>
#include <BRepTools_WireExplorer.hxx>
#include <Geom2d_TrimmedCurve.hxx>
#include <gp_Lin2d.hxx>
#include <Precision.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Wire.hxx>

//-----------------------------------------------------------------------------

asiAlgo_FindFeatureHints::asiAlgo_FindFeatureHints(const TopoDS_Face&   face,
                                                   ActAPI_ProgressEntry progress,
                                                   ActAPI_PlotterEntry  plotter)
: ActAPI_IAlgorithm(progress, plotter)
{
  m_face = face;
}

//-----------------------------------------------------------------------------

bool asiAlgo_FindFeatureHints::IsPuzzled()
{
  TopTools_IndexedMapOfShape wires;
  TopExp::MapShapes(m_face, TopAbs_WIRE, wires);
  //
  if ( wires.Extent() != 1 )
    return true;
  //
  TopoDS_Wire wire = TopoDS::Wire( wires.FindKey(1) );

  // Check parametric portrait. The following check is simple for polygonal
  // domains. For the curved ones we have to apply something different
  const double prec              = asiAlgo_CheckValidity::MaxTolerance(m_face)*0.1;
  int          iter              = 0;
  int          nCorners          = 0;
  bool         isPolygonalDomain = true;
  gp_Dir2d     prevDir;
  //
  for ( BRepTools_WireExplorer exp(wire); exp.More(); exp.Next() )
  {
    ++iter;

    // Take host line
    const TopoDS_Edge&  edge = exp.Current();
    Handle(Geom2d_Line) line = this->edgeAsLine(edge);
    //
    if ( line.IsNull() )
    {
      isPolygonalDomain = false; // Not a line? No line, no check, man.
      break;
    }

    // Take traverse direction
    gp_Dir2d dir = line->Lin2d().Direction();
    if ( edge.Orientation() == TopAbs_REVERSED )
      dir.Reverse();

    // Check angles
    if ( iter > 1 )
    {
      const double angle = Abs( prevDir.Angle(dir) );
      if ( Abs(angle) > prec && Abs(angle - M_PI/2) > prec )
        return true;

      if ( Abs(angle - M_PI/2) < prec )
        ++nCorners;
    }

    prevDir = dir;
  }

  // For curved domains we have to apply a more sophisticated check. But
  // today we do not have it...
  if ( !isPolygonalDomain )
  {
    int nEdges = 0;
    for ( TopExp_Explorer exp(wire, TopAbs_EDGE); exp.More(); exp.Next() )
      ++nEdges;
    //
    if ( nEdges != 4 )
      return true;
  }
  else if ( nCorners != 3 )
    return true; // Polyline should not have more than 4 corners

  return false;
}

//-----------------------------------------------------------------------------

Handle(Geom2d_Line)
  asiAlgo_FindFeatureHints::edgeAsLine(const TopoDS_Edge& edge) const
{
  double f, l;
  Handle(Geom2d_Curve) curve = BRep_Tool::CurveOnSurface(edge, m_face, f, l);
  //
  if ( curve->IsKind( STANDARD_TYPE(Geom2d_TrimmedCurve) ) )
  {
    Handle(Geom2d_TrimmedCurve) tcurve = Handle(Geom2d_TrimmedCurve)::DownCast(curve);
    //
    if ( !tcurve->BasisCurve()->IsInstance( STANDARD_TYPE(Geom2d_Line) ) )
      return NULL;

    curve = tcurve->BasisCurve();
  }
  Handle(Geom2d_Line) line = Handle(Geom2d_Line)::DownCast(curve);
  return line;
}
