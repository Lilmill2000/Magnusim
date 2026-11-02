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

#ifndef asiAlgo_ConvertCanonicalSummary_h
#define asiAlgo_ConvertCanonicalSummary_h

// asiAlgo includes
#include <asiAlgo_GeomSummary.h>

// Standard includes
#include <optional>

//-----------------------------------------------------------------------------

//! \ingroup ASI_MODELING
//!
//! Summary on canonical conversion.
struct asiAlgo_ConvertCanonicalSummary
{
  std::optional< std::pair<int, int> > nbSurfBezier;
  std::optional< std::pair<int, int> > nbSurfSpl;
  std::optional< std::pair<int, int> > nbSurfConical;
  std::optional< std::pair<int, int> > nbSurfCyl;
  std::optional< std::pair<int, int> > nbSurfOffset;
  std::optional< std::pair<int, int> > nbSurfSph;
  std::optional< std::pair<int, int> > nbSurfLinExtr;
  std::optional< std::pair<int, int> > nbSurfOfRevol;
  std::optional< std::pair<int, int> > nbSurfToroidal;
  std::optional< std::pair<int, int> > nbSurfPlane;
  std::optional< std::pair<int, int> > nbCurveBezier;
  std::optional< std::pair<int, int> > nbCurveSpline;
  std::optional< std::pair<int, int> > nbCurveCircle;
  std::optional< std::pair<int, int> > nbCurveEllipse;
  std::optional< std::pair<int, int> > nbCurveHyperbola;
  std::optional< std::pair<int, int> > nbCurveLine;
  std::optional< std::pair<int, int> > nbCurveOffset;
  std::optional< std::pair<int, int> > nbCurveParabola;

  //! Indicates whether the resulting shape is valid once the canonical
  //! conversion is done.
  std::optional<bool> isValid;

  //! Default ctor.
  asiAlgo_ConvertCanonicalSummary() = default;

  //! Ctor accepting two geometric summary structures.
  asiAlgo_ConvertCanonicalSummary(const asiAlgo_GeomSummary& sum1,
                                  const asiAlgo_GeomSummary& sum2)
  {
    if ( sum1.nbSurfBezier != sum2.nbSurfBezier )
    {
      nbSurfBezier = std::make_optional< std::pair<int, int> >();
      //
      nbSurfBezier->first  = sum1.nbSurfBezier;
      nbSurfBezier->second = sum2.nbSurfBezier;
    }

    if ( sum1.nbSurfSpl != sum2.nbSurfSpl )
    {
      nbSurfSpl = std::make_optional< std::pair<int, int> >();
      //
      nbSurfSpl->first  = sum1.nbSurfSpl;
      nbSurfSpl->second = sum2.nbSurfSpl;
    }

    if ( sum1.nbSurfConical != sum2.nbSurfConical )
    {
      nbSurfConical = std::make_optional< std::pair<int, int> >();
      //
      nbSurfConical->first  = sum1.nbSurfConical;
      nbSurfConical->second = sum2.nbSurfConical;
    }

    if ( sum1.nbSurfCyl != sum2.nbSurfCyl )
    {
      nbSurfCyl = std::make_optional< std::pair<int, int> >();
      //
      nbSurfCyl->first  = sum1.nbSurfCyl;
      nbSurfCyl->second = sum2.nbSurfCyl;
    }

    if ( sum1.nbSurfOffset != sum2.nbSurfOffset )
    {
      nbSurfOffset = std::make_optional< std::pair<int, int> >();
      //
      nbSurfOffset->first  = sum1.nbSurfOffset;
      nbSurfOffset->second = sum2.nbSurfOffset;
    }

    if ( sum1.nbSurfSph != sum2.nbSurfSph )
    {
      nbSurfSph = std::make_optional< std::pair<int, int> >();
      //
      nbSurfSph->first  = sum1.nbSurfSph;
      nbSurfSph->second = sum2.nbSurfSph;
    }

    if ( sum1.nbSurfLinExtr != sum2.nbSurfLinExtr )
    {
      nbSurfLinExtr = std::make_optional< std::pair<int, int> >();
      //
      nbSurfLinExtr->first  = sum1.nbSurfLinExtr;
      nbSurfLinExtr->second = sum2.nbSurfLinExtr;
    }

    if ( sum1.nbSurfOfRevol != sum2.nbSurfOfRevol )
    {
      nbSurfOfRevol = std::make_optional< std::pair<int, int> >();
      //
      nbSurfOfRevol->first  = sum1.nbSurfOfRevol;
      nbSurfOfRevol->second = sum2.nbSurfOfRevol;
    }

    if ( sum1.nbSurfToroidal != sum2.nbSurfToroidal )
    {
      nbSurfToroidal = std::make_optional< std::pair<int, int> >();
      //
      nbSurfToroidal->first  = sum1.nbSurfToroidal;
      nbSurfToroidal->second = sum2.nbSurfToroidal;
    }

    if ( sum1.nbSurfPlane != sum2.nbSurfPlane )
    {
      nbSurfPlane = std::make_optional< std::pair<int, int> >();
      //
      nbSurfPlane->first  = sum1.nbSurfPlane;
      nbSurfPlane->second = sum2.nbSurfPlane;
    }

    if ( sum1.nbCurveBezier != sum2.nbCurveBezier )
    {
      nbCurveBezier = std::make_optional< std::pair<int, int> >();
      //
      nbCurveBezier->first  = sum1.nbCurveBezier;
      nbCurveBezier->second = sum2.nbCurveBezier;
    }

    if ( sum1.nbCurveSpline != sum2.nbCurveSpline )
    {
      nbCurveSpline = std::make_optional< std::pair<int, int> >();
      //
      nbCurveSpline->first  = sum1.nbCurveSpline;
      nbCurveSpline->second = sum2.nbCurveSpline;
    }

    if ( sum1.nbCurveCircle != sum2.nbCurveCircle )
    {
      nbCurveCircle = std::make_optional< std::pair<int, int> >();
      //
      nbCurveCircle->first  = sum1.nbCurveCircle;
      nbCurveCircle->second = sum2.nbCurveCircle;
    }

    if ( sum1.nbCurveEllipse != sum2.nbCurveEllipse )
    {
      nbCurveEllipse = std::make_optional< std::pair<int, int> >();
      //
      nbCurveEllipse->first  = sum1.nbCurveEllipse;
      nbCurveEllipse->second = sum2.nbCurveEllipse;
    }

    if ( sum1.nbCurveHyperbola != sum2.nbCurveHyperbola )
    {
      nbCurveHyperbola = std::make_optional< std::pair<int, int> >();
      //
      nbCurveHyperbola->first  = sum1.nbCurveHyperbola;
      nbCurveHyperbola->second = sum2.nbCurveHyperbola;
    }

    if ( sum1.nbCurveLine != sum2.nbCurveLine )
    {
      nbCurveLine = std::make_optional< std::pair<int, int> >();
      //
      nbCurveLine->first  = sum1.nbCurveLine;
      nbCurveLine->second = sum2.nbCurveLine;
    }

    if ( sum1.nbCurveOffset != sum2.nbCurveOffset )
    {
      nbCurveOffset = std::make_optional< std::pair<int, int> >();
      //
      nbCurveOffset->first  = sum1.nbCurveOffset;
      nbCurveOffset->second = sum2.nbCurveOffset;
    }

    if ( sum1.nbCurveParabola != sum2.nbCurveParabola )
    {
      nbCurveParabola = std::make_optional< std::pair<int, int> >();
      //
      nbCurveParabola->first  = sum1.nbCurveParabola;
      nbCurveParabola->second = sum2.nbCurveParabola;
    }
  }

  //! Prints the summary contents to the given progress notifier.
  void Print(const std::string&   msg,
             ActAPI_ProgressEntry progress)
  {
    progress.SendLogMessage(LogInfo(Normal) << "=============================================");
    progress.SendLogMessage(LogInfo(Normal) << msg);
    progress.SendLogMessage(LogInfo(Normal) << "---------------------------------------------");

    if ( nbSurfBezier.has_value() )
    {
      progress.SendLogMessage(LogInfo(Normal) << "\tNum. bezier surfaces: (%1/%2)"
                                              << nbSurfBezier->first
                                              << nbSurfBezier->second);
    }

    if ( nbSurfSpl.has_value() )
    {
      progress.SendLogMessage(LogInfo(Normal) << "\tNum. b-spline surfaces: (%1/%2)"
                                              << nbSurfSpl->first
                                              << nbSurfSpl->second);
    }

    if ( nbSurfConical.has_value() )
    {
      progress.SendLogMessage(LogInfo(Normal) << "\tNum. conical surfaces: (%1/%2)"
                                              << nbSurfConical->first
                                              << nbSurfConical->second);
    }

    if ( nbSurfCyl.has_value() )
    {
      progress.SendLogMessage(LogInfo(Normal) << "\tNum. cylindrical surfaces: (%1/%2)"
                                              << nbSurfCyl->first
                                              << nbSurfCyl->second);
    }

    if ( nbSurfOffset.has_value() )
    {
      progress.SendLogMessage(LogInfo(Normal) << "\tNum. offset surfaces: (%1/%2)"
                                              << nbSurfOffset->first
                                              << nbSurfOffset->second);
    }

    if ( nbSurfSph.has_value() )
    {
      progress.SendLogMessage(LogInfo(Normal) << "\tNum. spherical surfaces: (%1/%2)"
                                              << nbSurfSph->first
                                              << nbSurfSph->second);
    }

    if ( nbSurfLinExtr.has_value() )
    {
      progress.SendLogMessage(LogInfo(Normal) << "\tNum. linear extrusion surfaces: (%1/%2)"
                                              << nbSurfLinExtr->first
                                              << nbSurfLinExtr->second);
    }

    if ( nbSurfOfRevol.has_value() )
    {
      progress.SendLogMessage(LogInfo(Normal) << "\tNum. surfaces of revolution: (%1/%2)"
                                              << nbSurfOfRevol->first
                                              << nbSurfOfRevol->second);
    }

    if ( nbSurfToroidal.has_value() )
    {
      progress.SendLogMessage(LogInfo(Normal) << "\tNum. toroidal surfaces: (%1/%2)"
                                              << nbSurfToroidal->first
                                              << nbSurfToroidal->second);
    }

    if ( nbSurfPlane.has_value() )
    {
      progress.SendLogMessage(LogInfo(Normal) << "\tNum. planar surfaces: (%1/%2)"
                                              << nbSurfPlane->first
                                              << nbSurfPlane->second);
    }

    if ( nbCurveBezier.has_value() )
    {
      progress.SendLogMessage(LogInfo(Normal) << "\tNum. bezier curves: (%1/%2)"
                                              << nbCurveBezier->first
                                              << nbCurveBezier->second);
    }

    if ( nbCurveSpline.has_value() )
    {
      progress.SendLogMessage(LogInfo(Normal) << "\tNum. b-spline curves: (%1/%2)"
                                              << nbCurveSpline->first
                                              << nbCurveSpline->second);
    }

    if ( nbCurveCircle.has_value() )
    {
      progress.SendLogMessage(LogInfo(Normal) << "\tNum. circular curves: (%1/%2)"
                                              << nbCurveCircle->first
                                              << nbCurveCircle->second);
    }

    if ( nbCurveEllipse.has_value() )
    {
      progress.SendLogMessage(LogInfo(Normal) << "\tNum. elliptical curves: (%1/%2)"
                                              << nbCurveEllipse->first
                                              << nbCurveEllipse->second);
    }

    if ( nbCurveHyperbola.has_value() )
    {
      progress.SendLogMessage(LogInfo(Normal) << "\tNum. hyperbolic curves: (%1/%2)"
                                              << nbCurveHyperbola->first
                                              << nbCurveHyperbola->second);
    }

    if ( nbCurveLine.has_value() )
    {
      progress.SendLogMessage(LogInfo(Normal) << "\tNum. straight line curves: (%1/%2)"
                                              << nbCurveLine->first
                                              << nbCurveLine->second);
    }

    if ( nbCurveOffset.has_value() )
    {
      progress.SendLogMessage(LogInfo(Normal) << "\tNum. offset curves: (%1/%2)"
                                              << nbCurveOffset->first
                                              << nbCurveOffset->second);
    }

    if ( nbCurveParabola.has_value() )
    {
      progress.SendLogMessage(LogInfo(Normal) << "\tNum. parabolic curves: (%1/%2)"
                                              << nbCurveParabola->first
                                              << nbCurveParabola->second);
    }
  }

  //! Checks if this canonical conversion summary equals the passed one.
  //! \param[in] other the canonical conversion summary to compare this one with.
  //! \return true in the case of equality, false -- otherwise.
  asiAlgo_EXPORT bool
    IsEqual(const asiAlgo_ConvertCanonicalSummary& other) const;

  //! Constructs the summary data structure from a JSON object.
  //! \param[in]  pJsonGenericObj the JSON object to construct the data structure from.
  //! \param[out] ccSummary       the outcome data structure.
  asiAlgo_EXPORT static void
    FromJSON(void*                            pJsonGenericObj,
             asiAlgo_ConvertCanonicalSummary& ccSummary);

  //! Converts the passed data structure to JSON (the passed `out` stream).
  //! \param[in]     ccSummary the data structure to serialize.
  //! \param[in]     indent    the pretty indentation shift.
  //! \param[in,out] out       the output JSON string stream.
  asiAlgo_EXPORT static void
    ToJSON(const asiAlgo_ConvertCanonicalSummary& ccSummary,
           const int                              indent,
           std::ostream&                          out);
};

#endif
