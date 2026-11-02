//-----------------------------------------------------------------------------
// Created on: 31 March 2016
//-----------------------------------------------------------------------------
// Copyright (c) 2016-present, Sergey Slyadnev
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

#ifndef asiAlgo_GeomSummary_h
#define asiAlgo_GeomSummary_h

// asiAlgo includes
#include <asiAlgo.h>

// Active Data includes
#include <ActAPI_IProgressNotifier.h>

//-----------------------------------------------------------------------------

//! \ingroup ASI_MODELING
//!
//! Counters for different types of geometric primitives in a shape.
struct asiAlgo_GeomSummary
{
  int nbSurfBezier;
  int nbSurfSpl;
  int nbSurfConical;
  int nbSurfCyl;
  int nbSurfOffset;
  int nbSurfSph;
  int nbSurfLinExtr;
  int nbSurfOfRevol;
  int nbSurfToroidal;
  int nbSurfPlane;
  int nbCurveBezier;
  int nbCurveSpline;
  int nbCurveCircle;
  int nbCurveEllipse;
  int nbCurveHyperbola;
  int nbCurveLine;
  int nbCurveOffset;
  int nbCurveParabola;

  //! Default ctor.
  asiAlgo_GeomSummary()
  : nbSurfBezier     (0),
    nbSurfSpl        (0),
    nbSurfConical    (0),
    nbSurfCyl        (0),
    nbSurfOffset     (0),
    nbSurfSph        (0),
    nbSurfLinExtr    (0),
    nbSurfOfRevol    (0),
    nbSurfToroidal   (0),
    nbSurfPlane      (0),
    nbCurveBezier    (0),
    nbCurveSpline    (0),
    nbCurveCircle    (0),
    nbCurveEllipse   (0),
    nbCurveHyperbola (0),
    nbCurveLine      (0),
    nbCurveOffset    (0),
    nbCurveParabola  (0)
  {}

  //! Nullifies all counters.
  void Reset()
  {
    nbSurfBezier     = 0;
    nbSurfSpl        = 0;
    nbSurfConical    = 0;
    nbSurfCyl        = 0;
    nbSurfOffset     = 0;
    nbSurfSph        = 0;
    nbSurfLinExtr    = 0;
    nbSurfOfRevol    = 0;
    nbSurfToroidal   = 0;
    nbSurfPlane      = 0;
    nbCurveBezier    = 0;
    nbCurveSpline    = 0;
    nbCurveCircle    = 0;
    nbCurveEllipse   = 0;
    nbCurveHyperbola = 0;
    nbCurveLine      = 0;
    nbCurveOffset    = 0;
    nbCurveParabola  = 0;
  }

  //! Checks if this structure equals the passed one.
  //! \param[in] other the data structur to check against.
  //! \return true in the case of equality, false -- otherwise.
  bool IsEqual(const asiAlgo_GeomSummary& other) const
  {
    if ( nbSurfBezier     != other.nbSurfBezier     ) return false;
    if ( nbSurfSpl        != other.nbSurfSpl        ) return false;
    if ( nbSurfConical    != other.nbSurfConical    ) return false;
    if ( nbSurfCyl        != other.nbSurfCyl        ) return false;
    if ( nbSurfOffset     != other.nbSurfOffset     ) return false;
    if ( nbSurfSph        != other.nbSurfSph        ) return false;
    if ( nbSurfLinExtr    != other.nbSurfLinExtr    ) return false;
    if ( nbSurfOfRevol    != other.nbSurfOfRevol    ) return false;
    if ( nbSurfToroidal   != other.nbSurfToroidal   ) return false;
    if ( nbSurfPlane      != other.nbSurfPlane      ) return false;
    if ( nbCurveBezier    != other.nbCurveBezier    ) return false;
    if ( nbCurveSpline    != other.nbCurveSpline    ) return false;
    if ( nbCurveCircle    != other.nbCurveCircle    ) return false;
    if ( nbCurveEllipse   != other.nbCurveEllipse   ) return false;
    if ( nbCurveHyperbola != other.nbCurveHyperbola ) return false;
    if ( nbCurveLine      != other.nbCurveLine      ) return false;
    if ( nbCurveOffset    != other.nbCurveOffset    ) return false;
    if ( nbCurveParabola  != other.nbCurveParabola  ) return false;
    return true;
  }

  //! Prints the summary contents to the given progress notifier.
  void Print(const std::string&   msg,
             ActAPI_ProgressEntry progress)
  {
    progress.SendLogMessage(LogInfo(Normal) << "=============================================");
    progress.SendLogMessage(LogInfo(Normal) << msg);
    progress.SendLogMessage(LogInfo(Normal) << "---------------------------------------------");
    progress.SendLogMessage(LogInfo(Normal) << "\tNum. bezier surfaces:           %1" << nbSurfBezier);
    progress.SendLogMessage(LogInfo(Normal) << "\tNum. spline surfaces:           %1" << nbSurfSpl);
    progress.SendLogMessage(LogInfo(Normal) << "\tNum. conical surfaces:          %1" << nbSurfConical);
    progress.SendLogMessage(LogInfo(Normal) << "\tNum. cylindrical surfaces:      %1" << nbSurfCyl);
    progress.SendLogMessage(LogInfo(Normal) << "\tNum. offset surfaces:           %1" << nbSurfOffset);
    progress.SendLogMessage(LogInfo(Normal) << "\tNum. spherical surfaces:        %1" << nbSurfSph);
    progress.SendLogMessage(LogInfo(Normal) << "\tNum. linear extrusion surfaces: %1" << nbSurfLinExtr);
    progress.SendLogMessage(LogInfo(Normal) << "\tNum. surfaces of revolution:    %1" << nbSurfOfRevol);
    progress.SendLogMessage(LogInfo(Normal) << "\tNum. toroidal surfaces:         %1" << nbSurfToroidal);
    progress.SendLogMessage(LogInfo(Normal) << "\tNum. planar surfaces:           %1" << nbSurfPlane);
    progress.SendLogMessage(LogInfo(Normal) << "\tNum. bezier curves:             %1" << nbCurveBezier);
    progress.SendLogMessage(LogInfo(Normal) << "\tNum. spline curves:             %1" << nbCurveSpline);
    progress.SendLogMessage(LogInfo(Normal) << "\tNum. circular curves:           %1" << nbCurveCircle);
    progress.SendLogMessage(LogInfo(Normal) << "\tNum. elliptical curves:         %1" << nbCurveEllipse);
    progress.SendLogMessage(LogInfo(Normal) << "\tNum. hyperbolic curves:         %1" << nbCurveHyperbola);
    progress.SendLogMessage(LogInfo(Normal) << "\tNum. straight line curves:      %1" << nbCurveLine);
    progress.SendLogMessage(LogInfo(Normal) << "\tNum. offset curves:             %1" << nbCurveOffset);
    progress.SendLogMessage(LogInfo(Normal) << "\tNum. parabolic curves:          %1" << nbCurveParabola);
  }
};

#endif
