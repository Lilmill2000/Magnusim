//-----------------------------------------------------------------------------
// Created on: 20 November 2015
//-----------------------------------------------------------------------------
// Copyright (c) 2017, Sergey Slyadnev
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

#ifndef asiAlgo_Utils_h
#define asiAlgo_Utils_h

// asiAlgo includes
#include <asiAlgo_BaseCloud.h>
#include <asiAlgo_BorderTrihedron.h>
#include <asiAlgo_Collections.h>
#include <asiAlgo_ConvertCanonicalSummary.h>
#include <asiAlgo_FeatureAngleType.h>
#include <asiAlgo_FeatureFaces.h>
#include <asiAlgo_FileFormat.h>
#include <asiAlgo_IntersectionCurveSS.h>
#include <asiAlgo_Naming.h>
#include <asiAlgo_TopoSummary.h>

// Active Data (API) includes
#include <ActAPI_ILogger.h>
#include <ActAPI_IProgressNotifier.h>

// Active Data includes
#include <ActData_Mesh.h>

// OCCT includes
#include <Bnd_Box.hxx>
#include <BRep_Tool.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <Geom_BezierSurface.hxx>
#include <Geom_BSplineCurve.hxx>
#include <Geom_BSplineSurface.hxx>
#include <Geom_Circle.hxx>
#include <Geom_ConicalSurface.hxx>
#include <Geom_Curve.hxx>
#include <Geom_CylindricalSurface.hxx>
#include <Geom_Line.hxx>
#include <Geom_OffsetSurface.hxx>
#include <Geom_Plane.hxx>
#include <Geom_RectangularTrimmedSurface.hxx>
#include <Geom_SphericalSurface.hxx>
#include <Geom_SurfaceOfLinearExtrusion.hxx>
#include <Geom_SurfaceOfRevolution.hxx>
#include <Geom_SweptSurface.hxx>
#include <Geom_ToroidalSurface.hxx>
#include <Geom_TrimmedCurve.hxx>
#include <Geom2d_BSplineCurve.hxx>
#include <Geom2d_TrimmedCurve.hxx>
#include <gp_Lin2d.hxx>
#include <gp_Trsf.hxx>
#include <Graphic3d_TypeOfShadingModel.hxx>
#include <math_BullardGenerator.hxx>
#include <math_Function.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Iterator.hxx>
#include <TopoDS_Vertex.hxx>
#include <TopoDS_Wire.hxx>
#include <TopTools_HSequenceOfShape.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_SequenceOfShape.hxx>

// Standard includes
#include <limits>
#include <optional>
#include <unordered_set>
#include <set>

//-----------------------------------------------------------------------------

#define asiAlgo_TooSmallValue 1.0e-4
#define asiAlgo_RangeLinPrec  0.01
#define asiAlgo_SlashStr      "/"
#define asiAlgo_QuoteStr      "\""
#define asiAlgo_IsPlanarToler 1.0e-3

//-----------------------------------------------------------------------------

// Forward declarations.
class Image_AlienPixMap;
class asiAlgo_AAG;

//-----------------------------------------------------------------------------

//! \ingroup ASI_MODELING
//!
//! Auxiliary functions facilitating working with OCCT topological shapes.
namespace asiAlgo_Utils
{
  //! Functions to work with strings.
  namespace Str
  {
    //! Fortranizes the passed integer value.
    //! \param[in] val the value to fortranize.
    //! \return the fortran-ish string representation.
    asiAlgo_EXPORT std::string
      Fortranize(const int val);

    //! Derives filename and extension out of the passed full path.
    //! \param[in]  fullPath  the input full path.
    //! \param[out] name      the output filename.
    //! \param[out] extension the output extension.
    asiAlgo_EXPORT void
      FileNameAndExtension(const TCollection_AsciiString& fullPath,
                           TCollection_AsciiString&       name,
                           TCollection_AsciiString&       extension);

    //! Splits the passed string by the given delimiter. Note that the
    //! passed output vector is not cleaned up beforehand.
    //! \param source_str [in]  input string to split.
    //! \param delim_str  [in]  delimiter string.
    //! \param result     [out] resulting collection of tokens after split.
    asiAlgo_EXPORT void
      Split(const std::string&        source_str,
            const std::string&        delim_str,
            std::vector<std::string>& result);

    //! Splits the passed string by the given delimiter. Note that the
    //! passed output vector is not cleaned up beforehand.
    //! \param source_str [in]  input string to split.
    //! \param delim      [in]  delimiter.
    //! \param result     [out] resulting collection of tokens after split.
    asiAlgo_EXPORT void
      Split(const TCollection_AsciiString&        source_str,
            const char*                           delim,
            std::vector<TCollection_AsciiString>& result);

    //! Replaces all occurrences of {what} with {with} in string {str}.
    //! \param str [in/out] target string.
    //! \param what [in] sub-string to replace.
    //! \param with [in] string to replace with.
    asiAlgo_EXPORT void
      ReplaceAll(std::string&       str,
                 const std::string& what,
                 const std::string& with);

    //! Replaces all occurrences of `what` with `with` in string `str`.
    //! \param[in,out] str  target string.
    //! \param[in]     what sub-string to replace.
    //! \param[in]     with string to replace with.
    asiAlgo_EXPORT void
      ReplaceAll(TCollection_AsciiString&       str,
                 const TCollection_AsciiString& what,
                 const TCollection_AsciiString& with);

    //! Extracts substring from the passed source.
    //! \param source [in] input string to extract substring from.
    //! \param idx_F  [in] 0-based index to start extraction from (inclusively).
    //! \param length [in] number of characters to extract.
    //! \return resulting substring.
    asiAlgo_EXPORT std::string
      SubStr(const std::string& source,
             const int          idx_F,
             const int          length);

    //! Returns the passed string ensuring that it is surrounded with quote
    //! characters. This is an equivalent function for `std::quoted()` to
    //! be used in C++11 development environment.
    //! \param[in] strIN input string.
    //! \return modified string.
    asiAlgo_EXPORT std::string
      Quoted(const char* strIN);

    //! Returns the passed string ensuring that it is surrounded with quote
    //! characters. This is an equivalent function for `std::quoted()` to
    //! be used in C++11 development environment.
    //! \param[in] strIN input string.
    //! \return modified string.
    asiAlgo_EXPORT std::string
      Quoted(const std::string& strIN);

    //! Returns the passed string ensuring that it has a trailing slash.
    //! \param[in] strIN input string.
    //! \return modified string.
    asiAlgo_EXPORT std::string
      Slashed(const char* strIN);

    //! Returns the passed string ensuring that it has a trailing slash.
    //! \param[in] strIN input string.
    //! \return modified string.
    asiAlgo_EXPORT std::string
      Slashed(const std::string& strIN);

    //! Returns the passed string ensuring that it has a trailing slash.
    //! \param[in] strIN input string.
    //! \return modified string.
    asiAlgo_EXPORT TCollection_AsciiString
      Slashed(const TCollection_AsciiString& strIN);

    //! Checks whether the passed string is number or not.
    //! \param str [in] string to check.
    //! \return true/false.
    asiAlgo_EXPORT bool
      IsNumber(const std::string& str);

    //! Converts the passed value to string. This function is used to
    //! substitute std::to_string() for compilers incompatible with
    //! C++ 11.
    //! \param value [in] value to convert.
    //! \return string.
    template <typename T>
    std::string ToString(T value)
    {
      std::ostringstream os;
      os << std::setprecision( std::numeric_limits<double>::max_digits10 );
      os << value;
      return os.str();
    }

    //! Converts the passed value to string. This function is used to
    //! substitute std::to_string() for compilers incompatible with
    //! C++ 11.
    //! \param value [in] value to convert.
    //! \return string.
    template <typename T>
    std::string ToString(T value, int prec)
    {
      std::ostringstream os;
      os << std::setprecision(prec) << std::fixed;
      os << value;
      return os.str();
    }

    //! Converts the passed string to number.
    //! \param str           [in] string to convert.
    //! \param default_value [in] default value to use.
    //! \return string.
    template <typename T>
    static T ToNumber(const std::string& str,
                      const T            default_value = 0)
    {
      std::istringstream is(str);
      T result;
      (is >> result) ? result : default_value;
      return result;
    }

    //! Derives the name of the directory which contains the file with
    //! the passed filename.
    //! \param[in] filename input filename.
    //! \return directory name.
    asiAlgo_EXPORT std::string
      FileDirectory(const std::string& filename);

    //! Derives the name of the directory which contains the file with
    //! the passed filename.
    //! \param[in] filename input filename.
    //! \return directory name.
    asiAlgo_EXPORT TCollection_AsciiString
      FileDirectory(const TCollection_AsciiString& filename);

    //! Extracts the name of the last directory from the
    //! given path.
    asiAlgo_EXPORT std::string
      LastDirname(const std::string& filename);

    //! Extracts base filename with or without extension.
    asiAlgo_EXPORT TCollection_AsciiString
      BaseFilename(const TCollection_AsciiString& filename,
                   const bool                     doKeepExt);

    //! Extracts base filename with or without extension.
    asiAlgo_EXPORT std::string
      BaseFilename(const std::string& filename,
                   const bool         doKeepExt);

    //! Given the full filename, this function transforms it to the
    //! reference data filename as `<path>/<basename>.ref`.
    //!
    //! \param[in] filename input filename.
    //! \param[in] refExt   extension of the reference file (normally it is "ref").
    //! \return full filename for the reference data file.
    asiAlgo_EXPORT std::string
      RefFilename(const std::string& filename,
                  const std::string& refExt);

    //! Given the full filename, this function transforms it to the
    //! suffixed filename as `<path>/<basename><suffix>.<ext>`,
    //! where `ext` is the original extension.
    //!
    //! \param[in] filename input filename.
    //! \param[in] suffix   suffix to insert.
    //! \return full amended filename.
    asiAlgo_EXPORT std::string
      AmendedFilename(const std::string& filename,
                      const std::string& suffix);
  } // Str namespace.

  //! Functions for working with environment.
  namespace Env
  {
    asiAlgo_EXPORT
      std::string AsiTestData();

    asiAlgo_EXPORT
      std::string AsiTestDumping();

    asiAlgo_EXPORT
      std::string AsiTestScripts();

    asiAlgo_EXPORT
      std::string AsiDocs();

    asiAlgo_EXPORT
      std::string GetVariable(const char* varName);
  } // Env namespace.

  //! Functions to work with JSON-formatted strings.
  namespace Json
  {
    //! Dumps an iterable to JSON.
    //! \param[in] iterable the iterable to dump
    //! \return a JSON representation of the given iterable, e.g. [1, 2, 3].
    template <typename T>
    std::string FromIterable(const T& iterable)
    {
      std::stringstream out;

      out << "[";
      if ( !iterable.empty() )
      {
        auto it = iterable.begin();
        out << *it++;

        for ( auto end = iterable.end(); it != end; ++it )
        {
          out << ", " << *it;
        }
      }
      out << "]";

      return out.str();
    }

    //! Dumps the passed elements as a set in JSON.
    //! \param[in] elements the elements to dump.
    //! \return the outcome string representation of the elements.
    template <class T>
    std::string FromUnorderedSet(const std::unordered_set<T>& elements)
    {
      std::ostringstream result;

      result << "{ ";
      bool first = true;
      for ( const auto& elem : elements )
      {
        if (first) first = false;
        else       result << ", ";
        result << elem;
      }
      result << " }";

      return result.str();
    }

    //! Reads the passed JSON block as an array of integers and
    //! populates the second argument to compose a feature out
    //! of that array.
    //! \param[in]  jsonBlock the JSON block to interpret.
    //! \param[out] feature   the feature to compose.
    asiAlgo_EXPORT void
      ReadFeature(void*            pJsonBlock,
                  asiAlgo_Feature& feature);

    //! Reads the passed JSON block as an array of integer arrays.
    //! \param[in]  pJsonBlock the JSON block to interpret.
    //! \param[out] features   the container of features to compose.
    asiAlgo_EXPORT void
      ReadFeatures(void*                         pJsonBlock,
                   std::vector<asiAlgo_Feature>& features);

    //! Reads the passed JSON block as a pair of integers.
    //! \param[in]  jsonBlock the JSON block to interpret.
    //! \param[out] pair      the pair to compose.
    asiAlgo_EXPORT void
      ReadPair(void*                                 pJsonBlock,
               std::optional< std::pair<int, int> >& pair);

    //! Reads the passed JSON block as a triple of coordinates.
    //! \param[in]  pJsonBlock the JSON block to interpret.
    //! \param[out] coords     the outcome coords.
    asiAlgo_EXPORT void
      ReadCoords(void*   pJsonBlock,
                 gp_XYZ& coords);

    //! Reads the passed JSON block as a pair of coordinates.
    //! \param[in]  pJsonBlock the JSON block to interpret.
    //! \param[out] coords     the outcome coords.
    asiAlgo_EXPORT void
      ReadCoords(void*  pJsonBlock,
                 gp_XY& coords);

    //! Dumps the passed feature as a JSON array.
    //! \param[in] map the map to dump.
    //! \return a JSON array containing the elements of the map.
    asiAlgo_EXPORT std::string
      FromFeature(const asiAlgo_Feature& map);

    //! Dumps the passed direction as a JSON array.
    //! \param[in] gp_Dir the direction to dump.
    //! \return `[X(), Y(), Z()]`.
    asiAlgo_EXPORT std::string
      FromDirAsTuple(const gp_Dir& dir);

    //! Dumps the passed coordinates as a JSON array.
    //! \param[in] pnt the point to dump.
    //! \return '[X(), Y(), Z()]' string.
    asiAlgo_EXPORT std::string
      FromPointAsTuple(const gp_Pnt& pnt);

    //! Dumps the passed coordinates as a JSON array.
    //! \param[in] xyz the coordinates to dump.
    //! \return '[X(), Y(), Z()]' string.
    asiAlgo_EXPORT std::string
      FromCoordsAsTuple(const gp_XYZ& xyz);

    //! Dumps the passed coordinates as a JSON array.
    //! \param[in] xy the coordinates to dump.
    //! \return '[X(), Y()]' string.
    asiAlgo_EXPORT std::string
      FromCoordsAsTuple(const gp_XY& xy);

    //! Dumps the passed pair as a JSON array.
    //! \param[in] pair the pair to dump.
    //! \return a JSON array containing the elements of the pair.
    asiAlgo_EXPORT std::string
      FromPair(const std::optional< std::pair<int, int> >& pair);

    //! Handles special symbols in string 's' and escape them using
    //! additional backslash.
    //! \param[in] s the string to proceed.
    //! \return a string with 'escaped' symbols.
    asiAlgo_EXPORT std::string
      EscapeJson(const std::string& s);

    //! Reads the passed JSON block as a array of integers and
    //! populates the second argument to compose a vector out
    //! of that array.
    //! \param[in]  jsonBlock the JSON block to interpret.
    //! \param[out] vector    the vector to compose.
    asiAlgo_EXPORT void
      ReadVector(void*             pJsonBlock,
                 std::vector<int>& vector);

    //! Reads the passed JSON block as a array of doubles and
    //! populates the second argument to compose a vector out
    //! of that array.
    //! \param[in]  jsonBlock the JSON block to interpret.
    //! \param[out] vector    the vector to compose.
    asiAlgo_EXPORT void
      ReadVectord(void*                pJsonBlock,
                  std::vector<double>& vector);

    //! Reads the array of two-dimensional points from the passed JSON
    //! block to the given output vector.
    //! \param[in]  pJsonGenericObj the JSON block to interpret.
    //! \param[out] vector          the vector to compose.
    asiAlgo_EXPORT void
      ReadPoints(void*               pJsonGenericObj,
                 std::vector<gp_XY>& contour);

    //! Dumps the passed vector of integers as a JSON array.
    //! \param[in] v the vector to dump.
    //! \return a JSON array containing the elements of the vector.
    asiAlgo_EXPORT std::string
      FromVector(const std::vector<int>& v);

  }

  //! Functions for verification of results.
  namespace Verify
  {
    //! Compares two passed floating-point values.
    //! \param[in] val1         the first value.
    //! \param[in] val2         the second value.
    //! \param[in] diff_percent the allowed difference in percentage regarding to
    //!                         average value.
    //! \param[in] resolution   the resolution for very small numbers (which are
    //!                         impractical to compare: e.g. 0.0001 is 100% different from
    //!                         0.0002, but both values are too small to consider this
    //!                         difference as significant).
    //! \return true in case of such fuzzy equality, false -- otherwise.
    asiAlgo_EXPORT bool
      AreEqual(const double val1,
               const double val2,
               const double diff_percent,
               const double resolution);

    //! Compares two passed coordinate triplets.
    //! \param[in] coords1      the first coordinate triplet.
    //! \param[in] coords2      the second coordinate triplet.
    //! \param[in] diff_percent the allowed difference in percentage regarding to
    //!                         average value.
    //! \param[in] resolution   the resolution for very small numbers (which are
    //!                         impractical to compare: e.g. 0.0001 is 100% different from
    //!                         0.0002, but both values are too small to consider this
    //!                         difference as significant).
    //! \return true in case of such fuzzy equality, false -- otherwise.
    asiAlgo_EXPORT bool
      AreEqual(const gp_XYZ& coords1,
               const gp_XYZ& coords2,
               const double  diff_percent,
               const double  resolution);

    //! Compares two passed 3D points.
    //! \param[in] P1           the first point.
    //! \param[in] P2           the second point.
    //! \param[in] diff_percent the allowed difference in percentage regarding to
    //!                         average value.
    //! \param[in] resolution   the resolution for very small numbers (which are
    //!                         impractical to compare: e.g. 0.0001 is 100% different from
    //!                         0.0002, but both values are too small to consider this
    //!                         difference as significant).
    //! \return true in case of such fuzzy equality, false -- otherwise.
    asiAlgo_EXPORT bool
      AreEqual(const gp_Pnt& P1,
               const gp_Pnt& P2,
               const double  diff_percent,
               const double  resolution);

    //! Compares the two passed vectors by counting and matching occurrences
    //! of each element.
    //! \param[in] V1   the first vector.
    //! \param[in] V2   the second vector.
    //! \param[in] prec the precision to use.
    //! \return true for matching vector, false -- otherwise.
    asiAlgo_EXPORT bool
      CompareOccurrences(const std::vector<double>& V1,
                         const std::vector<double>& V2,
                         const double               prec);

    //! This method compares two optionals given that they can have different states, i.e. initialized (has value)
    //! versus uninitialized. While on Windows direct comparison of the dereferenced values was quite Ok, on Linux
    //! we have to take special care of the optionals' states to avoid surprises at runtime.
    //! \param[in] a the first optional to compare.
    //! \param[in] b the second optional to compare.
    //! \return true in case of equality, false -- otherwise.
    asiAlgo_EXPORT bool
      AreEqual(const std::optional<bool>& a,
               const std::optional<bool>& b);

    //! This method compares two optionals given that they can have different states, i.e. initialized (has value)
    //! versus uninitialized. While on Windows direct comparison of the dereferenced values was quite Ok, on Linux
    //! we have to take special care of the optionals' states to avoid surprises at runtime.
    //! \param[in] a    the first optional to compare.
    //! \param[in] b    the second optional to compare.
    //! \param[in] prec the numerical precision to use in the case when both optionals are initialized.
    //! \return true in case of equality, false -- otherwise.
    asiAlgo_EXPORT bool
      AreEqual(const std::optional<double>& a,
               const std::optional<double>& b,
               const double                 prec);

    //! This method compares two optional axes given that they can have different states, i.e. initialized (has value)
    //! versus uninitialized. While on Windows direct comparison of the dereferenced values was quite Ok, on Linux
    //! we have to take special care of the optionals' states to avoid surprises at runtime.
    //! \param[in] a           the first optional to compare.
    //! \param[in] b           the second optional to compare.
    //! \param[in] angTolerDeg the angular precision to use in the case when both optionals are initialized.
    //! \return true in case of equality, false -- otherwise.
    asiAlgo_EXPORT bool
      AreEqualAxes(const std::optional<gp_Ax1>& a,
                   const std::optional<gp_Ax1>& b,
                   const double                 angTolerDeg);

    //! This method compares two optional dirs given that they can have different states, i.e. initialized (has value)
    //! versus uninitialized. While on Windows direct comparison of the dereferenced values was quite Ok, on Linux
    //! we have to take special care of the optionals' states to avoid surprises at runtime.
    //! \param[in] a           the first optional to compare.
    //! \param[in] b           the second optional to compare.
    //! \param[in] angTolerDeg the angular precision to use in the case when both optionals are initialized.
    //! \return true in case of equality, false -- otherwise.
    asiAlgo_EXPORT bool
      AreEqualDirs(const std::optional<gp_Dir>& a,
                   const std::optional<gp_Dir>& b,
                   const double                 angTolerDeg);
  } // Verify namespace

  namespace Graphics
  {
    //! Default color of shape for offscreen rendering.
    static constexpr double CompColorOfShape()
    {
      return 200.0 / 255.0;
    }

    //! Default color of background for offscreen rendering.
    static constexpr double CompColorOfBg()
    {
      return 255.0 / 255.0;
    }

    //! Generates the picture of the given shape from the axonometric camera view.
    //! The off-screen rendering technique is used.
    //! \param[in] shape      the shape to screeenshot.
    //! \param[in] width      the target width of the output image.
    //! \param[in] height     the target height of the output image.
    //! \param[in] shapeColor the color of the shape in RGB.
    //! \param[in] bgColor    the color of the background in RGB.
    //! \param[in] dm         the shading display mode.
    //! \param[in] viewDir    the optional view direction (defaults to V3d_XposYnegZpos).
    //! \param[in] viewUp     the optional world-up axis. When provided, controls
    //!                       the rotation of the camera about the line of sight
    //!                       (useful for Y-up CAD coordinates). When omitted, the
    //!                       OCCT default up that pairs with the view direction
    //!                       is used.
    //! \return the generated in-memory pixmap.
    asiAlgo_EXPORT Handle(Image_AlienPixMap)
      GeneratePixmap(const TopoDS_Shape&                shape,
                     const int                          width,
                     const int                          height,
                     const Quantity_Color&              shapeColor = Quantity_Color(CompColorOfShape(),
                                                                                    CompColorOfShape(),
                                                                                    CompColorOfShape(),
                                                                                    Quantity_TOC_RGB),
                     const Quantity_Color&              bgColor = Quantity_Color(CompColorOfBg(),
                                                                                 CompColorOfBg(),
                                                                                 CompColorOfBg(),
                                                                                 Quantity_TOC_RGB),
                     const Graphic3d_TypeOfShadingModel dm = Graphic3d_TypeOfShadingModel_DEFAULT,
                     const std::optional<gp_Dir>&       viewDir = std::nullopt,
                     const std::optional<gp_Dir>&       viewUp  = std::nullopt);

    //! Generates the picture of the given shape from the axonometric camera view.
    //! The off-screen rendering technique is used.
    //! \param[in] shape      the shape to screeenshot.
    //! \param[in] width      the target width of the output image.
    //! \param[in] height     the target height of the output image.
    //! \param[in] filename   the outcome filename.
    //! \param[in] shapeColor the color of the shape in RGB.
    //! \param[in] bgColor    the color of the background.
    //! \param[in] dm         the shading display mode.
    //! \param[in] viewDir    the optional view direction (defaults to V3d_XposYnegZpos).
    //! \param[in] viewUp     the optional world-up axis. When provided, controls
    //!                       the rotation of the camera about the line of sight
    //!                       (useful for Y-up CAD coordinates). When omitted, the
    //!                       OCCT default up that pairs with the view direction
    //!                       is used.
    //! \return true in case of success, false -- otherwise.
    asiAlgo_EXPORT bool
      GeneratePicture(const TopoDS_Shape&                shape,
                      const int                          width,
                      const int                          height,
                      const std::string&                 filename,
                      const Quantity_Color&              shapeColor = Quantity_Color(CompColorOfShape(),
                                                                                     CompColorOfShape(),
                                                                                     CompColorOfShape(),
                                                                                     Quantity_TOC_RGB),
                      const Quantity_Color&              bgColor = Quantity_Color(CompColorOfBg(),
                                                                                  CompColorOfBg(),
                                                                                  CompColorOfBg(),
                                                                                  Quantity_TOC_RGB),
                      const Graphic3d_TypeOfShadingModel dm = Graphic3d_TypeOfShadingModel_DEFAULT,
                      const std::optional<gp_Dir>&       viewDir = std::nullopt,
                      const std::optional<gp_Dir>&       viewUp  = std::nullopt);
  } // Graphics namespace.

  //! Functions for working with 1-dimensional ranges.
  namespace Range
  {
    //! Range.
    typedef std::pair<double, double> t_range;

    //! Range associated with a face.
    typedef std::pair<int, t_range> t_rangeByFace;

    //! Ranges by faces.
    typedef std::vector<t_rangeByFace> t_rangesByFaces;

    //! Checks if the first range contains the second one.
    //! \param[in] range1 the first range to check.
    //! \param[in] range2 the second range to check.
    //! \param[in] strict the Boolean flag indicating whether the range
    //!                   check should use strict inequality checks.
    //! \param[in] tol    the tolerance to use for non-strict inequality test.
    //! \return true/false.
    asiAlgo_EXPORT bool
      Contains(const t_range& range1,
               const t_range& range2,
               const bool     strict,
               const double   tol = asiAlgo_RangeLinPrec);

    //! Checks if the passed ranges are geometrically coincident.
    //! \param[in] range1 the first range to check.
    //! \param[in] range2 the second range to check.
    //! \return true/false.
    asiAlgo_EXPORT bool
      Coincide(const t_range& range1,
               const t_range& range2);

    //! Checks if the passed `range1` left-overlaps or included into `range2`.
    //! Run this function twice with the swapped arguments to perform full test.
    //! \param[in] range1 the first range to check.
    //! \param[in] range2 the second range to check.
    //! \return true in the case of overlapping, false otherwise.
    asiAlgo_EXPORT bool
      Overlap(const t_range& range1,
              const t_range& range2);

    //! Merges the passed two ranges and returns the merged one.
    //! \param[in] range1 the first range.
    //! \param[in] range2 the second range.
    //! \return the merged range.
    asiAlgo_EXPORT t_range
      Merge(const t_range& range1,
            const t_range& range2);

    //! Intersects the passed range with the domain range.
    //! \param[in]  range the range in question.
    //! \param[in]  hmin  the min domain bound.
    //! \param[in]  hmax  the max domain bound.
    //! \param[out] res   the intersection result.
    //! \return true if the intersecting range is non-degenrated,
    //!         false -- otherwise.
    asiAlgo_EXPORT bool
      Intersect(const t_range& range,
                const double   hmin,
                const double   hmax,
                t_range&       res);

    //! Merges all ranges in the passed `inputRanges` collection, so that
    //! we end up with non-overlapping maximal ranges in the output `merged`
    //! collection.
    //! \param[in]  inputRanges the input ranges to process.
    //! \param[out] merged      the merged ranges.
    asiAlgo_EXPORT void
      MergeRanges(const t_rangesByFaces& inputRanges,
                  t_rangesByFaces&       merged);

    //! Checks if the passed ranges are identical.
    //! \param[in] ranges1 the first collection of ranges.
    //! \param[in] ranges2 the second collection of ranges.
    //! \return true/false.
    asiAlgo_EXPORT bool
      AreEqual(const t_rangesByFaces& ranges1,
               const t_rangesByFaces& ranges2);

  } // Range namespace.

  //! Functions for working with binary formats.
  namespace Binary
  {
    //! Writes a little-endian 32 bits integer to the `pResult` byte buffer.
    //! \param[in]      value   the number to write.
    //! \param[in, out] pResult the byte buffer to represent the passed number.
    asiAlgo_EXPORT void
      WriteInt(const int value,
               char*     pResult);

    //! Writes a little-endian 32 bits integer to the binary file passed by
    //! its opened file handler.
    //! \param[in] value the number to write.
    //! \param[in] pFile the opened file handler.
    //! \param[in] close the Boolean flag indicating whether to close the file
    //!                  handler if write operation fails.
    //! \return false if `fwrite()` is impossible.
    asiAlgo_EXPORT bool
      WriteInt(const int  value,
               FILE*      pFile,
               const bool close = false);

    //! Writes a little-endian 32 bits float to the `pResult` byte buffer.
    //! \param[in]      value   the number to write.
    //! \param[in, out] pResult the byte buffer to represent the passed number.
    asiAlgo_EXPORT void
      WriteFloat(const double value,
                 char*        pResult);

    //! Writes a little-endian 32 bits float to the binary file passed by
    //! its opened file handler.
    //! \param[in] value the number to write.
    //! \param[in] pFile the opened file handler.
    //! \param[in] close the Boolean flag indicating whether to close the file
    //!                  handler if write operation fails.
    //! \return false if `fwrite()` is impossible.
    asiAlgo_EXPORT bool
      WriteFloat(const double value,
                 FILE*        pFile,
                 const bool   close = false);

    //! Read a little-endian 32 bits integer from the passed byte buffer.
    //! \param[in] pData the buffer to read.
    //! \return the obtained integer value.
    asiAlgo_EXPORT int
      ReadInt(const char* pData);
  } // Binary namespace.

  //! Returns a human-readable name of the passed direction.
  //! \param[in] dir the direction to get a string name for.
  //! \return label.
  asiAlgo_EXPORT std::string
    DirectionName(const gp_Dir& dir);

  //! Returns geometry of a face as a string label.
  //! \param face [in] face to inspect.
  //! \return label.
  asiAlgo_EXPORT std::string
    FaceGeometryName(const TopoDS_Face& face);

  //! Converts the passed named shape to string.
  asiAlgo_EXPORT TCollection_AsciiString
    NamedShapeToString(const TopoDS_Shape&           subShape,
                       const int                     pedigreeId,
                       const int                     globalId,
                       const Handle(asiAlgo_Naming)& naming);

  //! Converts orientation of the given shape to string.
  //! \param shape [in] shape to access orientation.
  //! \return string representation of orientation.
  asiAlgo_EXPORT TCollection_AsciiString
    OrientationToString(const TopoDS_Shape& shape);

  //! Converts the passed orientation to string.
  //! \param ori [in] orientation to convert.
  //! \return string representation of orientation.
  asiAlgo_EXPORT TCollection_AsciiString
    OrientationToString(const TopAbs_Orientation ori);

  //! Converts the passed continuity to string.
  //! \param[in] cont continuity.
  //! \return string representation of continuity.
  asiAlgo_EXPORT TCollection_AsciiString
    ContinuityToString(const GeomAbs_Shape cont);

  //! Method for combining edges to wires.
  //! \param[in]  edges     edges.
  //! \param[in]  isShared  indicator showing how the merge should take place.
  //!                       If true, then edges with the same vertex are merged.
  //!                       If false, then the edges are merged within the tolerance.
  //! \param[out] contours  extracted contours.
  //! \param[in]  tolerance tolerance.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    ConnectEdgesToWires(const std::vector<TopoDS_Edge>& edges,
                        const bool                      isShared,
                        std::vector<TopoDS_Wire>&       contours,
                        const double                    tolerance = 1e-3);

  //! Method for combining edges to wires.
  //! Note: there is no check for degenerate edges. External verification required.
  //! \param[in]      isShared  indicator showing how the merge should take place.
  //!                           If true, then edges with the same vertex are merged.
  //!                           If false, then the edges are merged within the tolerance.
  //! \param[in, out] edges     edges.
  //! \param[out]     contours  extracted contours.
  //! \param[in]      tolerance tolerance.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    ConnectEdgesToWires(const bool                         isShared,
                        Handle(TopTools_HSequenceOfShape)& edges,
                        std::vector<TopoDS_Wire>&          contours,
                        const double                       tolerance = 1e-3);

  //! Converts the passed location to string.
  //! \param loc [in] location to convert.
  //! \return string representation of location.
  asiAlgo_EXPORT TCollection_AsciiString
    LocationToString(const TopLoc_Location& loc);

  //! Returns human-readable curve name.
  //! \param curve [in] curve to inspect.
  //! \return curve name.
  asiAlgo_EXPORT std::string
    CurveName(const Handle(Geom_Curve)& curve);

  //! Returns human-readable surface name for the given surface type.
  //! \param[in] surfType surface type to inspect.
  //! \return surface name.
  asiAlgo_EXPORT std::string
    SurfaceName(const Handle(Standard_Type)& surfType);

  //! Returns human-readable surface name.
  //! \param[in] surf surface to inspect.
  //! \return surface name.
  asiAlgo_EXPORT std::string
    SurfaceName(const Handle(Geom_Surface)& surf);

  //! Returns shape type as string.
  //! \param shapeType [in] shape type in question.
  //! \return type as string.
  asiAlgo_EXPORT std::string
    ShapeTypeStr(const TopAbs_ShapeEnum& shapeType);

  //! Returns shape type as string.
  //! \param shape [in] shape to get type string for.
  //! \return type string.
  asiAlgo_EXPORT std::string
    ShapeTypeStr(const TopoDS_Shape& shape);

  //! Returns shape address as string with a prefix indicating its type,
  //! e.g. "e05FB0" is an edge and "f780A1" is a face.
  //! \param shape [in] shape to extract the address for.
  //! \return address of TShape as string prefixed by type indicator.
  asiAlgo_EXPORT std::string
    ShapeAddrWithPrefix(const TopoDS_Shape& shape);

  //! Returns TShape address as string.
  //! \param tshape [in] TShape pointer to extract the address for.
  //! \return address of TShape as string.
  asiAlgo_EXPORT std::string
    ShapeAddr(const Handle(TopoDS_TShape)& tshape);

  //! Returns TShape address as string.
  //! \param shape [in] shape to extract the address for.
  //! \return address of TShape as string.
  asiAlgo_EXPORT std::string
    ShapeAddr(const TopoDS_Shape& shape);

  //! Checks curve type.
  //! \param[in]  curve     the curve to check.
  //! \param[out] basecurve the extracted basis curve if the originally
  //!                       passed one is trimmed.
  //! \return true/false.
  template<typename TCurve>
  bool IsTypeOf(const Handle(Geom2d_Curve)& curve,
                Handle(TCurve)&             basecurve)
  {
    if( curve.IsNull() ) {
      return false;
    }

    if ( curve->IsInstance( STANDARD_TYPE(TCurve) ) )
    {
      basecurve = Handle(TCurve)::DownCast(curve);
      return true;
    }

    if ( curve->IsInstance( STANDARD_TYPE(Geom2d_TrimmedCurve) ) )
    {
      Handle(Geom2d_TrimmedCurve) trimmed =
        Handle(Geom2d_TrimmedCurve)::DownCast(curve);

      if( trimmed.IsNull() ) {
        return false;
      }

      Handle(Geom2d_Curve) basis = trimmed->BasisCurve();

      if ( IsTypeOf<TCurve>(basis, basecurve) )
      {
        return true;
      }
    }

    return false;
  }

  //! Checks curve type.
  //! \param[in]  curve     the curve to check.
  //! \param[out] basecurve the extracted basis curve if the originally
  //!                       passed one is trimmed.
  //! \return true/false.
  template<typename TCurve>
  bool IsTypeOf(const Handle(Geom_Curve)& curve,
                Handle(TCurve)&           basecurve)
  {
    if( curve.IsNull() ) {
      return false;
    }

    if ( curve->IsInstance( STANDARD_TYPE(TCurve) ) )
    {
      basecurve = Handle(TCurve)::DownCast(curve);
      return true;
    }

    if ( curve->IsInstance( STANDARD_TYPE(Geom_TrimmedCurve) ) )
    {
      Handle(Geom_TrimmedCurve) trimmed =
        Handle(Geom_TrimmedCurve)::DownCast(curve);

      if( trimmed.IsNull() ) {
        return false;
      }

      Handle(Geom_Curve) basis = trimmed->BasisCurve();

      if ( IsTypeOf<TCurve>(basis, basecurve) )
      {
        return true;
      }
    }

    return false;
  }

  //! Checks curve type.
  //! \param[in] curve the curve to check.
  //! \return true/false.
  template<typename TCurve>
  bool IsTypeOf(const Handle(Geom_Curve)& curve)
  {
    Handle(TCurve) basecurve;
    return IsTypeOf<TCurve>(curve, basecurve);
  }

  //! Checks edge type.
  //! \param[in]  edge      edge to check.
  //! \param[out] basecurve base curve.
  //! \return true/false.
  template<typename TCurve>
  bool IsTypeOf(const TopoDS_Edge& edge,
                Handle(TCurve)&    basecurve)
  {
    if ( edge.IsNull() )
      return false;

    double f, l;
    Handle(Geom_Curve) curve = BRep_Tool::Curve(edge, f, l);
    //
    if ( curve.IsNull() )
      return false;

    // Check host curve directly.
    if ( curve->IsInstance( STANDARD_TYPE(TCurve) ) )
    {
      basecurve = Handle(TCurve)::DownCast(curve);
      return true;
    }

    // Check trimmed curve which may encapsulate the curve type we're looking for.
    if ( curve->IsInstance( STANDARD_TYPE(Geom_TrimmedCurve) ) )
    {
      Handle(Geom_TrimmedCurve)
        TC = Handle(Geom_TrimmedCurve)::DownCast(curve);

      if( TC.IsNull() ) {
        return false;
      }

      // Check basis curve.
      basecurve = Handle(TCurve)::DownCast( TC->BasisCurve() );
      //
      if ( !basecurve.IsNull() )
        return true;
    }

    return false;
  }

  //! Checks edge type.
  //! \param[in] edge edge to check.
  //! \return true/false.
  template<typename TCurve>
  bool IsTypeOf(const TopoDS_Edge& edge)
  {
    Handle(TCurve) basecurve;
    return IsTypeOf<TCurve>(edge, basecurve);
  }

  //! Checks face type.
  //! \param[in]  face     face to check.
  //! \param[out] basesurf base surface.
  //! \return true/false.
  template<typename TSurf>
  bool IsTypeOf(const TopoDS_Face& face,
                Handle(TSurf)&     basesurf)
  {
    if ( face.IsNull() )
      return false;

    Handle(Geom_Surface) surf = BRep_Tool::Surface(face);

    if( surf.IsNull() ) {
      return false;
    }

    // Check host surface directly.
    if ( surf->IsInstance( STANDARD_TYPE(TSurf) ) )
    {
      basesurf = Handle(TSurf)::DownCast(surf);
      return true;
    }

    // Check trimmed surface which may encapsulate the surface type we're looking for.
    if ( surf->IsInstance( STANDARD_TYPE(Geom_RectangularTrimmedSurface) ) )
    {
      Handle(Geom_RectangularTrimmedSurface)
        RT = Handle(Geom_RectangularTrimmedSurface)::DownCast(surf);

      if( RT.IsNull() ) {
        return false;
      }
      // Check basis surface.
      basesurf = Handle(TSurf)::DownCast( RT->BasisSurface() );
      //
      if ( !basesurf.IsNull() )
        return true;
    }

    return false;
  }

  //! Checks face type.
  //! \param[in] face face to check.
  //! \return true/false.
  template<typename TSurf>
  bool IsTypeOf(const TopoDS_Face& face)
  {
    Handle(TSurf) basesurf;
    return IsTypeOf<TSurf>(face, basesurf);
  }

  //! Checks surface type.
  //! \param[in] surf surface to check.
  //! \return true/false.
  template<typename TSurf>
  static bool IsTypeOf(const Handle(Geom_Surface)& surf)
  {
    if( surf.IsNull() ) {
      return false;
    }

    Handle(TSurf) basesurf;

    // Check host surface directly.
    if ( surf->IsInstance( STANDARD_TYPE(TSurf) ) )
    {
      return true;
    }

    // Check trimmed surface which may encapsulate the surface type we're looking for.
    if ( surf->IsInstance( STANDARD_TYPE(Geom_RectangularTrimmedSurface) ) )
    {
      Handle(Geom_RectangularTrimmedSurface)
        RT = Handle(Geom_RectangularTrimmedSurface)::DownCast(surf);

      if( RT.IsNull() ) {
        return false;
      }

      // Check basis surface.
      basesurf = Handle(TSurf)::DownCast( RT->BasisSurface() );
      //
      if ( !basesurf.IsNull() )
        return true;
    }

    return false;
  }

  //! Checks if the passed face has planar support.
  //!
  //! The passed tolerance is used for recognizing as planar
  //! those surfaces that are not defined as analytic planes.
  //!
  //! \param[in] face   face to check.
  //! \param[in] canrec whether to try canonical recognition.
  //! \param[in] toler  the tolerance to use.
  //!
  //! \return true/false.
  asiAlgo_EXPORT bool
    IsPlanar(const TopoDS_Face& face,
             const bool         canrec,
             const double       tol = asiAlgo_IsPlanarToler);

  //! Checks if the passed face has planar support.
  //!
  //! The passed tolerance is used for recognizing as planar
  //! those surfaces that are not defined as analytic planes.
  //!
  //! \param[in]  face   face to check.
  //! \param[out] plane  planar support.
  //! \param[in]  canrec whether to try canonical recognition.
  //! \param[in]  toler  the tolerance to use.
  //!
  //! \return true/false.
  asiAlgo_EXPORT bool
    IsPlanar(const TopoDS_Face&  face,
             Handle(Geom_Plane)& plane,
             const bool          canrec,
             const double        tol = asiAlgo_IsPlanarToler);

  //! Checks if the passed face has cylindrical support.
  //! \param[in] face face to check.
  //! \return true/false.
  asiAlgo_EXPORT bool
    IsCylindrical(const TopoDS_Face& face);

  //! Checks if the passed face has cylindrical support and returns the
  //! extracted cylindrical primitive.
  //! \param[in]  face face to check.
  //! \param[out] cyl  extracted cylindrical primitive.
  //! \return true/false.
  asiAlgo_EXPORT bool
    IsCylindrical(const TopoDS_Face& face,
                  gp_Cylinder&       cyl);

  //! Checks if the passed face has cylindrical support.
  //! \param[in]  face face to check.
  //! \param[out] ax   axis of the cylindrical surface.
  //! \return true/false.
  asiAlgo_EXPORT bool
    IsCylindrical(const TopoDS_Face& face,
                  gp_Ax1&            ax);

  //! Checks if the passed face has cylindrical support and returns the
  //! cylinder's radius.
  //! \param[in]  face   face to check.
  //! \param[out] radius radius of the underlying cylinder.
  //! \return true/false.
  asiAlgo_EXPORT bool
    IsCylindrical(const TopoDS_Face& face,
                  double&            radius);

  //! Checks if the passed face has cylindrical support and returns the
  //! basic properties of a cylinder.
  //! \param[in]  face      face to check.
  //! \param[out] radius    radius of the underlying cylinder.
  //! \param[out] ax        axis of the cylinder.
  //! \param[out] angle_min min angle.
  //! \param[out] angle_max max angle.
  //! \return true/false.
  asiAlgo_EXPORT bool
    IsCylindrical(const TopoDS_Face& face,
                  double&            radius,
                  gp_Ax1&            ax,
                  double&            angle_min,
                  double&            angle_max);

  //! Checks if the passed face has cylindrical support and returns the
  //! basic properties of a cylinder.
  //! \param[in]  face          face to check.
  //! \param[out] radius        radius of the underlying cylinder.
  //! \param[out] ax            axis of the cylinder.
  //! \param[in]  computeBounds indicates whether to compute UV bounds of the cylindrical face.
  //!                           This parameter should be `true` in most cases. When it is `false`,
  //!                           the props `angle_min`, `angle_max`, `h_min`, and `h_max` remain
  //!                           uninitialized, but the computations get faster (as not bounding
  //!                           box is computed). Set this argument `false` if you are only
  //!                           interested in the radius and axis of the cylinder.
  //! \param[out] angle_min     min angle.
  //! \param[out] angle_max     max angle.
  //! \param[out] h_min         min longitudal parameter value.
  //! \param[out] h_max         max longitudal parameter value.
  //! \return true/false.
  asiAlgo_EXPORT bool
    IsCylindrical(const TopoDS_Face& face,
                  double&            radius,
                  gp_Ax1&            ax,
                  const bool         computeBounds,
                  double&            angle_min,
                  double&            angle_max,
                  double&            h_min,
                  double&            h_max);

  //! Checks whether the passed face has conical support.
  //! \param[in] face face to check.
  //! \return true/false.
  asiAlgo_EXPORT bool
    IsConical(const TopoDS_Face& face);

  //! Checks whether the passed face has conical support.
  //! \param[in]  face face to check.
  //! \param[out] ax1  cone axis.
  //! \return true/false.
  asiAlgo_EXPORT bool
    IsConical(const TopoDS_Face& face,
              gp_Ax1&            ax1);

  //! Checks if the passed face is conical and, if so, extract its
  //! properties.
  //! \param[in]  face          the face to check.
  //! \param[out] ax            the cone axis.
  //! \param[in]  computeBounds the Boolean flag indicating whether to compute
  //!                           UV bounds of a face. This operation can be computationally
  //!                           costly, so it should be asked specifically.
  //! \param[out] angle_min     the min angle (U min).
  //! \param[out] angle_max     the max angle (U max).
  //! \param[out] h_min         the min height parameter (V min).
  //! \param[out] h_max         the max height parameter (V max).
  //! \param[out] minRadius     the min extracted radius.
  //! \param[out] maxRadius     the max extracted radius.
  //! \return true if the passed face is conical, false -- otherwise.
  asiAlgo_EXPORT bool
    IsConical(const TopoDS_Face& face,
              gp_Ax1&            ax,
              const bool         computeBounds,
              double&            angle_min,
              double&            angle_max,
              double&            h_min,
              double&            h_max,
              double&            minRadius,
              double&            maxRadius);

  //! Checks whether the passed face has spherical support.
  //! \param[in] face face to check.
  //! \return true/false.
  asiAlgo_EXPORT bool
    IsSpherical(const TopoDS_Face& face);

  //! Checks whether the passed face has toroidal support.
  //! \param[in] face face to check.
  //! \return true/false.
  asiAlgo_EXPORT bool
    IsToroidal(const TopoDS_Face& face);

  //! Checks whether the passed face is a torus.
  //! \param[in]  face face to check.
  //! \param[out] rmax major radius of the host torus.
  //! \return true/false.
  asiAlgo_EXPORT bool
    IsToroidal(const TopoDS_Face& face,
               double&            rmax);

  //! Checks whether the passed face is a torus.
  //! \param[in]  face face to check.
  //! \param[out] ax   axis of the torus.
  //! \return true/false.
  asiAlgo_EXPORT bool
    IsToroidal(const TopoDS_Face& face,
               gp_Ax1&            ax);

  //! Checks whether the passed face is a torus.
  //! \param[in]  face face to check.
  //! \param[out] rmin outer minor radius of the host torus.
  //! \param[out] rmax major radius of the host torus.
  //! \param[out] ax   axis of the torus.
  //! \return true/false.
  asiAlgo_EXPORT bool
    IsToroidal(const TopoDS_Face& face,
               double&            rmin,
               double&            rmax,
               gp_Ax1&            ax);

  //! Checks if the passed edge is circular.
  //! \param[in] edge edge to check.
  //! \return true/false.
  asiAlgo_EXPORT bool
    IsCircular(const TopoDS_Edge& edge);

  //! Checks if the passed edge is circular and returns the circle props.
  //! \param[in]  edge the edge to check.
  //! \param[out] circ the extracted circle.
  //! \return true/false.
  asiAlgo_EXPORT bool
    IsCircular(const TopoDS_Edge& edge,
               gp_Circ&           circ);

  //! Checks if the passed curve is circular.
  //! \param[in] curve curve to check.
  //! \return true/false.
  asiAlgo_EXPORT bool
    IsCircular(const Handle(Geom_Curve)& curve);

  //! Checks if the passed curve is circular.
  //! \param[in]  curve     the curve to check.
  //! \param[out] circ      the extracted circle.
  //! \param[in]  canrec    the Boolean flag indicating whether to try
  //!                       canonical recognition.
  //! \param[in]  canrecTol the canonical recognition tolerance (if this
  //!                       mode is activated with the previous argument).
  //! \return true/false.
  asiAlgo_EXPORT bool
    IsCircular(const Handle(Geom_Curve)& curve,
               gp_Circ&                  circ,
               const bool                canrec = false,
               const double              canrecTol = 0.01);

  //! Checks if the passed edge is circular with canonical conversion for freeform
  //! curves plugged in.
  //! \param[in]  edge   the edge to check.
  //! \param[out] circ   the extracted circle.
  //! \param[in]  canrec whether to try canonical recognition.
  //! \return true/false.
  asiAlgo_EXPORT bool
    IsCircular(const TopoDS_Edge& edge,
               gp_Circ&           circ,
               const bool         canrec);

  //! Checks if the passed edge is straight.
  //! \param[in] edge edge to check.
  //! \return true/false.
  asiAlgo_EXPORT bool
    IsStraight(const TopoDS_Edge& edge);

  //! Checks if the passed edge is straight.
  //! \param[in]  edge edge to check.
  //! \param[out] line host curve of the straight edge.
  //! \return true/false.
  asiAlgo_EXPORT bool
    IsStraight(const TopoDS_Edge& edge,
               Handle(Geom_Line)& line);

  //! Checks if the passed edge is straight with canonical conversion for freeform
  //! curves plugged in.
  //! \param[in]  edge   edge to check.
  //! \param[out] lin    line props for a straight edge.
  //! \param[in]  canrec whether to try canonical recognition.
  //! \return true/false.
  asiAlgo_EXPORT bool
    IsStraight(const TopoDS_Edge& edge,
               gp_Lin&            lin,
               const bool         canrec);

  //! Checks if the passed pcurve is a straight line.
  //! \param[in] pcu    pcurve to check.
  //! \param[in] canrec whether to try canonical recognition.
  //! \return true/false.
  asiAlgo_EXPORT bool
    IsStraightPCurve(const Handle(Geom2d_Curve)& pcu,
                     const bool                  canrec);

  //! Checks if the passed pcurve is a straight line.
  //! \param[in]  pcu    pcurve to check.
  //! \param[out] lin    straight line primitive.
  //! \param[in]  canrec whether to try canonical recognition.
  //! \return true/false.
  asiAlgo_EXPORT bool
    IsStraightPCurve(const Handle(Geom2d_Curve)& pcu,
                     gp_Lin2d&                   lin,
                     const bool                  canrec);

  //! Checks whether the passed shape is empty. A series of nested
  //! compounds is also considered an empty shape.
  //! \param[in] shape the shape to check.
  //! \return true for empty shape, false -- otherwise.
  asiAlgo_EXPORT bool
    IsEmptyShape(const TopoDS_Shape& shape);

  //! Checks whether the passed location (a transformation matrix) is
  //! identity (i.e., it defines no real transformation).
  //! \param[in] loc the location to check.
  //! \return true for the identity, false -- otherwise.
  asiAlgo_EXPORT bool
    IsIdentity(const TopLoc_Location& loc);

  //! Checks whether the curve or its basic curve is circular.
  //! \param[in] curve curve to check.
  //! \return true/false.
  asiAlgo_EXPORT bool
    IsBasisCircular(const Handle(Geom_Curve)& curve);

  //! Checks if the passed planar surfaces are parallel.
  //! \param[in] S1      the first surface to check.
  //! \param[in] S2      the second surface to check.
  //! \param[in] angPrec the angular precision to use.
  //! \return true/false.
  asiAlgo_EXPORT bool
    AreParallel(const Handle(Geom_Plane)& S1,
                const Handle(Geom_Plane)& S2,
                const double              angPrec);

  //! Applies the passed transformation to the given shape. Returns another shape
  //! as a result (no deep copy of geometry is performed, only location is
  //! changed).
  //! \param[in] shape  shape to apply transformation to.
  //! \param[in] XPos   X position.
  //! \param[in] YPos   Y position.
  //! \param[in] ZPos   Z position.
  //! \param[in] AngleA rotation angle A (radians).
  //! \param[in] AngleB rotation angle B (radians).
  //! \param[in] AngleC rotation angle C (radians).
  //! \param[in] doCopy whether to copy the shape.
  //! \return relocated shape.
  asiAlgo_EXPORT TopoDS_Shape
    ApplyTransformation(const TopoDS_Shape& shape,
                        const double        XPos,
                        const double        YPos,
                        const double        ZPos,
                        const double        AngleA,
                        const double        AngleB,
                        const double        AngleC,
                        const bool          doCopy);

  //! Returns OCCT transformation structure for the given elemental
  //! transformations.
  //! \param theXPos   [in] X position.
  //! \param theYPos   [in] Y position.
  //! \param theZPos   [in] Z position.
  //! \param theAngleA [in] rotation angle A (radians).
  //! \param theAngleB [in] rotation angle B (radians).
  //! \param theAngleC [in] rotation angle C (radians).
  //! \return OCCT transformation structure.
  asiAlgo_EXPORT gp_Trsf
    Transformation(const double theXPos,
                   const double theYPos,
                   const double theZPos,
                   const double theAngleA,
                   const double theAngleB,
                   const double theAngleC);

  //! Applies the passed transformation to the given shape.
  //! \param theShape     [in] shape to transform.
  //! \param theTransform [in] transformation to apply.
  //! \param doCopy       [in] indicates whether to construct a deep copy.
  //! \return transformed shape.
  asiAlgo_EXPORT TopoDS_Shape
    ApplyTransformation(const TopoDS_Shape& theShape,
                        const gp_Trsf&      theTransform,
                        const bool          doCopy);

  //! Applies the passed transformation to the given mesh.
  //! \param mesh [in, out] the mesh to transform.
  //! \param T    [in]      the transformation to apply.
  asiAlgo_EXPORT void
    ApplyTransformation(const Handle(Poly_Triangulation)& mesh,
                        const gp_Trsf&                    T);

  //! Prepares one shape out of the passed collection of subshapes. Is there
  //! is only one subshape passed, it will be returned without any changes.
  //! For multiple subshapes, a compound is constructed and returned. This
  //! function also tries to guess if the user wanted to keep subshapes in
  //! meaningful groups, e.g., faces in a shell. If so, instead of a compound,
  //! this function might return a more appropriate shape type.
  //!
  //! \param[in] subshapes the subshapes to collect into a single shape.
  //! \return one shape.
  asiAlgo_EXPORT TopoDS_Shape
    AssembleShape(const TopTools_IndexedMapOfShape& subshapes);

  //! This function is identical to `AssembleShape()` above but allows
  //! to pass face IDs as an input.
  //!
  //! \param[in] fids the faces to collect into a single shape.
  //! \param[in] aag  the AAG instance.
  //! \return one shape.
  asiAlgo_EXPORT TopoDS_Shape
    AssembleShape(const asiAlgo_Feature&     fids,
                  const Handle(asiAlgo_AAG)& aag);

  //! Calculates bounding box for the given shape.
  //! \param shape     [in]  input shape.
  //! \param XMin      [out] min X.
  //! \param YMin      [out] min Y.
  //! \param ZMin      [out] min Z.
  //! \param XMax      [out] max X.
  //! \param YMax      [out] max Y.
  //! \param ZMax      [out] max Z.
  //! \param tolerance [in]  tolerance to enlarge the bounding box with.
  //! \param optimize  [in]  whether to optimize bbox with numerical methods.
  //! \return false if bounding box is void.
  asiAlgo_EXPORT bool
    Bounds(const TopoDS_Shape& shape,
           double& XMin, double& YMin, double& ZMin,
           double& XMax, double& YMax, double& ZMax,
           const double tolerance = 0.0,
           const bool optimize = true);

  //! Computes the axis-aligned bounding box for the passed shape.
  //! \param[in]  shape     the shape of interest.
  //! \param[in]  useFacets indicates whether to compute bounding box on facets.
  //! \param[in]  keepGap   indicates whether to preserve "gap" of AABB set by OpenCascade.
  //! \param[out] bndBox    the computed axis-aligned bounding box.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    Bounds(const TopoDS_Shape& shape,
           const bool          useFacets,
           const bool          keepGap,
           Bnd_Box&            bndBox);

  //! Calculates bounding box for the given triangulation.
  //! \param[in]  mesh        input mesh.
  //! \param[in]  loc         transformation to apply to the input mesh.
  //! \param[out] bndBox      bounding box.
  //! \return true if operation is successful and false otherwise.
  asiAlgo_EXPORT bool
    Bounds(const Handle(Poly_Triangulation)& mesh,
           const TopLoc_Location&            loc,
           Bnd_Box&                          bndBox);

  //! Calculates bounding box for the given triangulation.
  //! \param tris      [in]  input triangulation.
  //! \param XMin      [out] min X.
  //! \param YMin      [out] min Y.
  //! \param ZMin      [out] min Z.
  //! \param XMax      [out] max X.
  //! \param YMax      [out] max Y.
  //! \param ZMax      [out] max Z.
  //! \param tolerance [in]  tolerance to enlarge the bounding box with.
  //! \return false if bounding box is void.
  asiAlgo_EXPORT bool
    Bounds(const Handle(Poly_Triangulation)& tris,
           double& XMin, double& YMin, double& ZMin,
           double& XMax, double& YMax, double& ZMax,
           const double tolerance = 0.0);

  //! Computes the reference axes on a side of a bounding box which
  //! corresponds to the passed direction vector `dir`.
  asiAlgo_EXPORT std::optional<gp_Ax3>
    GetBboxSideFrame(const gp_Dir& dir,
                     const double  xMin,
                     const double  yMin,
                     const double  zMin,
                     const double  xMax,
                     const double  yMax,
                     const double  zMax);

  //! Computes axis-aligned bounding box volume of the passed shape.
  //! \param[in] shape     the shape in question.
  //! \param[in] tolerance the tolerance to use.
  //! \param[in] isPrecise the Boolean flag indicating whether to use precise
  //!                      bbox computation.
  //! \return the computed volume.
  asiAlgo_EXPORT double
    ComputeAABBVolume(const TopoDS_Shape& shape,
                      const double        tolerance = 0.0,
                      const bool          isPrecise = false);

  //! Handles getting areas of faces using the AAG as a cache.
  //! \param[in] fid the AAG node id of the face.
  //! \param[in] aag the AAG instance.
  //! \return the area of the face of interest.
  asiAlgo_EXPORT double
    CacheFaceArea(const int                  fid,
                  const Handle(asiAlgo_AAG)& aag);

  //! Computes surface area of the passed shape.
  //! \param[in] shape shape in question.
  //! \return computed area.
  asiAlgo_EXPORT double
    ComputeArea(const TopoDS_Shape& shape);

  //! Computes the two-dimensional bounding box of a wire `W`
  //! on the face `F`. This function makes sure to compute
  //! tight bounding rectangles.
  //!
  //! \sa https://quaoar.su/blog/page/outerwire-problem-of-opencascade
  //!
  //! \param[in]  F       the face in question.
  //! \param[in]  W       the wire in question.
  //! \param[out] umin    the computed U min value.
  //! \param[out] umax    the computed U max value.
  //! \param[out] vmin    the computed V min value.
  //! \param[out] vmax    the computed V max value.
  //! \param[in]  plotter the optional imperative plotter for visual dumps.
  asiAlgo_EXPORT void
    ComputeWireUVBounds(const TopoDS_Face&  F,
                        const TopoDS_Wire&  W,
                        double&             umin,
                        double&             umax,
                        double&             vmin,
                        double&             vmax,
                        ActAPI_PlotterEntry plotter = nullptr);

  //! Handles getting UV bounds of faces using the AAG as a cache.
  //! \param[in]  fid  the AAG node id of the face.
  //! \param[in]  aag  the AAG instance.
  //! \param[out] umin the U min value.
  //! \param[out] umax the U max value.
  //! \param[out] vmin the V min value.
  //! \param[out] vmax the V max value.
  asiAlgo_EXPORT void
    CacheFaceUVBounds(const int                  fid,
                      const Handle(asiAlgo_AAG)& aag,
                      double&                    umin,
                      double&                    umax,
                      double&                    vmin,
                      double&                    vmax);

  //! Computes length of the passed face by projecting its vertices
  //! to the given axis.
  //! \param[in]  face the face in question.
  //! \param[in]  axis the axis in question.
  //! \param[in]  tris the Boolean flag indicating whether to use triangulation
  //!                  or just get start/middle/end vertices of each edge.
  //! \param[out] hmin the lower bound of the axial range.
  //! \param[out] hmax the upper bound of the axial range.
  //! \return the computed face length w.r.t. the passed axis.
  asiAlgo_EXPORT double
    ComputeFaceLength(const TopoDS_Face& face,
                      const gp_Ax1&      axis,
                      const bool         useTriangulation,
                      double&            hmin,
                      double&            hmax);

  //! Handles getting face axial range using the AAG as a cache.
  //! \param[in]  fid  the AAG node id of the face.
  //! \param[in]  aag  the AAG instance.
  //! \param[in]  ax   the axis of rotation.
  //! \param[out] hmin the left bound.
  //! \param[out] hmax the right bound.
  asiAlgo_EXPORT void
    CacheFaceRange(const int                  fid,
                    const Handle(asiAlgo_AAG)& aag,
                    const gp_Ax1&              ax,
                    double&                    hmin,
                    double&                    hmax);

  //! Finds trasformation to move the reference frame `B` so that it is
  //! superimposed with the reference frame `A`.
  //! \param[in] A target reference frame.
  //! \param[in] B reference frame to move.
  //! \return computed transformation.
  asiAlgo_EXPORT gp_Trsf
    GetAlignmentTrsf(const gp_Ax3& A,
                     const gp_Ax3& B);

  //! Cleans up polygonal data from the passed shape.
  asiAlgo_EXPORT void
    CleanFacets(TopoDS_Shape& shape);

  //! Reads CAD model from native OCCT b-rep file.
  //! \param filename [in]  filename.
  //! \param shape    [out] CAD model retrieved from file.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    ReadBRep(const TCollection_AsciiString& filename,
             TopoDS_Shape&                  shape);

  //! Writes shape to B-Rep format.
  //! \param shape    [in] shape to write.
  //! \param filename [in] filename.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    WriteBRep(const TopoDS_Shape&            shape,
              const TCollection_AsciiString& filename);

  //! Reads CAD model from IGES.
  //! \param [in]  filename filename.
  //! \param [out] shape    CAD model retrieved from file.
  //! \param [in]  progress progress notifier.
  //! \param [in]  plotter  the imperative plotter to use.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    ReadIGES(const TCollection_AsciiString& filename,
             TopoDS_Shape&                  shape,
             ActAPI_ProgressEntry           progress = nullptr,
             ActAPI_PlotterEntry            plotter  = nullptr);

  //! Reads triangulation from STL.
  //! \param[in]  filename      source filename.
  //! \param[out] triangulation output triangulation.
  //! \param[in]  progress      progress notifier.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    ReadStl(const TCollection_AsciiString& filename,
            Handle(Poly_Triangulation)&    triangulation,
            ActAPI_ProgressEntry           progress);

  //! Reads PLY tessellation from file.
  //! \param[in]  filename source filename.
  //! \param[out] mesh     output tessellation.
  //! \param[in]  progress progress notifier.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    ReadPly(const TCollection_AsciiString& filename,
            Handle(ActData_Mesh)&          mesh,
            ActAPI_ProgressEntry           progress);

  //! Reads PLY triangulation from file.
  //! \param[in]  filename source filename.
  //! \param[out] mesh     output triangulation.
  //! \param[in]  progress progress notifier.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    ReadPly(const TCollection_AsciiString& filename,
            Handle(Poly_Triangulation)&    triangulation,
            ActAPI_ProgressEntry           progress);

  //! Reads OBJ tessellation from file.
  //! \param[in]  filename source filename.
  //! \param[out] mesh     output tessellation.
  //! \param[in]  progress progress notifier.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    ReadObj(const TCollection_AsciiString& filename,
            Handle(ActData_Mesh)&          mesh,
            ActAPI_ProgressEntry           progress);

  //! Reads OBJ triangulation from file.
  //! \param[in]  filename source filename.
  //! \param[out] mesh     output triangulation.
  //! \param[in]  progress progress notifier.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    ReadObj(const TCollection_AsciiString& filename,
            Handle(Poly_Triangulation)&    triangulation,
            ActAPI_ProgressEntry           progress);

  //! Writes triangulation to STL file.
  //! \param[in] triangulation triangulation to write.
  //! \param[in] filename      target filename.
  //! \param[in] isBinary      indicator showing whether to save
  //!                          the mesh in Ascii format or binary
  //!                          format.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    WriteStl(const Handle(Poly_Triangulation)& triangulation,
             const TCollection_AsciiString&    filename,
             const bool                        isBinary = false);

  //! Writes triangulation to PLY file.
  //! \param[in] triangulation triangulation to write.
  //! \param[in] filename      target filename.
  //! \param[in] progress      progress notifier.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    WritePly(const Handle(Poly_Triangulation)& triangulation,
             const TCollection_AsciiString&    filename,
             ActAPI_ProgressEntry              progress);

  //! Collects summary information for the given shape.
  //! \param shape   [in]  input shape.
  //! \param summary [out] shape summary.
  asiAlgo_EXPORT void
    ShapeSummary(const TopoDS_Shape&  shape,
                 asiAlgo_TopoSummary& summary);

  //! Collects summary information of the given shape: returns the number
  //! of sub-shapes of each type.
  //! \param shape [in]  shape to analyze.
  //! \param info  [out] shape summary as string.
  asiAlgo_EXPORT void
    ShapeSummary(const TopoDS_Shape&      shape,
                 TCollection_AsciiString& info);

  //! Creates a circular wire with the given radius.
  //! \param radius [in] radius of the host circle.
  //! \return created wire.
  asiAlgo_EXPORT TopoDS_Wire
    CreateCircularWire(const double radius);

  //! Skins a surface through the passed sections.
  //! \param wires [in] sections to skin.
  //! \return skinning result.
  asiAlgo_EXPORT TopoDS_Shape
    MakeSkin(const TopTools_SequenceOfShape& wires);

  //! Performs sewing (face stitching).
  //! \param[in]  shape       the shape to sew.
  //! \param[in]  tolerance   the sewing tolerance.
  //! \param[in]  nonmanifold the non-manifold mode switcher.
  //! \param[out] result      the resulting shape.
  //! \param[out] history     the collected sewing history.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    Sew(const TopoDS_Shape&      shape,
        const double             tolerance,
        const bool               nonmanifold,
        TopoDS_Shape&            result,
        Handle(asiAlgo_History)& history);

  //! Performs sewing and face maximization operations one after another.
  //! The history of modifications is the concatentation of two history
  //! trackers.
  //! \param[in]  nonmaximized the input shape.
  //! \param[in]  sewingTol    the sewing tolerance.
  //! \param[out] maximized    the resulting shape.
  //! \param[out] history      the resulting history.
  //! \param[in]  progress     the progress notifier.
  //! \param[in]  plotter      the imperative plotter.
  //! \return true in the case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    SewMaximize(const TopoDS_Shape&      nonmaximized,
                const double             sewingTol,
                TopoDS_Shape&            maximized,
                Handle(asiAlgo_History)& history,
                ActAPI_ProgressEntry     progress = nullptr,
                ActAPI_PlotterEntry      plotter  = nullptr);

  //! Maximizes all faces in the provided shape and returns the corresponding
  //! history tracker.
  //! \param[in,out] shape   the shape to maximize.
  //! \param[in,out] history the corresponding history tracker.
  //! \return true in the case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    MaximizeFaces(TopoDS_Shape&            shape,
                  Handle(asiAlgo_History)& history);

  //! Performs "same domain" expansion on faces and edges.
  //! \param[in,out] shape          the shape to modify.
  //! \param[in]     linToler       the linear maximization tolerance.
  //! \param[in]     angToler       the angular maximization tolerance.
  //! \param[in]     protectionMode enables post-merge UV extent check for cylinders.
  //! \param[in]     progress       the progress notifier for diagnostics.
  //! \param[in]     plotter        the imperative plotter for diagnostics.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    MaximizeFaces(TopoDS_Shape&      shape,
                  const double       linToler       = Precision::Confusion(),
                  const double       angToler       = 0.1,
                  const bool         protectionMode = false,
                  ActAPI_ProgressEntry progress     = nullptr,
                  ActAPI_PlotterEntry  plotter      = nullptr);

  //! Performs "same domain" expansion on faces and edges.
  //! \param[in,out] shape          the shape to modify.
  //! \param[out]    history        the modification history.
  //! \param[in]     linToler       the linear maximization tolerance.
  //! \param[in]     angToler       the angular maximization tolerance.
  //! \param[in]     protectionMode enables post-merge UV extent check for cylinders.
  //! \param[in]     progress       the progress notifier for diagnostics.
  //! \param[in]     plotter        the imperative plotter for diagnostics.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    MaximizeFaces(TopoDS_Shape&              shape,
                  Handle(BRepTools_History)& history,
                  const double               linToler       = Precision::Confusion(),
                  const double               angToler       = 0.1,
                  const bool                 protectionMode = false,
                  ActAPI_ProgressEntry        progress      = nullptr,
                  ActAPI_PlotterEntry         plotter       = nullptr);

  //! Converts the passed shape to a canonical form.
  //! \param[in,out] shape         the shape to convert.
  //! \param[in]     tol           the tolerance to use.
  //! \param[in]     checkValidity the Boolean flag indicating whether to check for validity
  //!                              after the conversion is done.
  //! \param[out]    summary       the conversion summary.
  //! \param[in]     planeOnly     the Boolean flag indicating whether only planar faces
  //!                              are to be converted.
  //! \param[in]     progress      the progress notifier.
  //! \return true in the case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    ConvertCanonical(TopoDS_Shape&                    shape,
                     const double                     tol,
                     const bool                       checkValidity,
                     asiAlgo_ConvertCanonicalSummary& summary,
                     const bool                       planeOnly = false,
                     ActAPI_ProgressEntry             progress  = nullptr);

  //! Interpolates the given collection of points with B-curve of the
  //! desired degree.
  //! \param points [in]  points to interpolate.
  //! \param p      [in]  degree to use.
  //! \param result [out] interpolant.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    InterpolatePoints(const std::vector<gp_XYZ>& points,
                      const int                  p,
                      Handle(Geom_BSplineCurve)& result);

  asiAlgo_EXPORT bool
    InterpolatePoints(const Handle(asiAlgo_BaseCloud<double>)& points,
                      const int                                p,
                      Handle(Geom_BSplineCurve)&               result);

  //! Approximate the given vector of points with a B-curve of the
  //! desired degree.
  //! \param[in]  points points to approximate.
  //! \param[in]  degMin min degree to use.
  //! \param[in]  degMax max degree to limit polynomial order.
  //! \param[in]  tol3d  3D tolerance.
  //! \param[out] result interpolant.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    ApproximatePoints(const std::vector<gp_XYZ>& points,
                      const int                  degMin,
                      const int                  degMax,
                      const double               tol3d,
                      Handle(Geom_BSplineCurve)& result);

  //! Fills the passed contour with a parametric surface using the
  //! constraint-filling algorithm of OpenCascade.
  //! \param[in]  curves curves defining the contour to fill.
  //! \param[out] result resulting patch.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    Fill4Contour(const std::vector<Handle(Geom_BSplineCurve)>& curves,
                 Handle(Geom_BSplineSurface)&                  result);

  //! Fills the passed contour with a Coons surface.
  //! \param[in]  C0       curve c0.
  //! \param[in]  C1       curve c1.
  //! \param[in]  B0       curve b0.
  //! \param[in]  B1       curve b1.
  //! \param[out] result   resulting patch as B-surface.
  //! \param[in]  progress progress entry.
  //! \param[in]  plotter  imperative plotter.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    FillCoons(const Handle(Geom_BSplineCurve)& C0,
              const Handle(Geom_BSplineCurve)& C1,
              const Handle(Geom_BSplineCurve)& B0,
              const Handle(Geom_BSplineCurve)& B1,
              Handle(Geom_BSplineSurface)&     result,
              ActAPI_ProgressEntry             progress,
              ActAPI_PlotterEntry              plotter);

  //! Fills the passed contour with a parametric surface using the Plate
  //! algorithm of OpenCascade to produce a class A surface.
  //! \param[in]  curves curves defining the contour to fill.
  //! \param[out] result resulting patch.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    FillContourPlate(const std::vector<Handle(Geom_BSplineCurve)>& curves,
                     Handle(Geom_BSplineSurface)&                  result);

  //! Performs Boolean Cut of a tool shape from the given object shape.
  //! \param Object [in] object to cut from.
  //! \param Tool   [in] tool to cut out.
  //! \param fuzzy  [in] fuzzy tolerance.
  //! \return result shape.
  asiAlgo_EXPORT TopoDS_Shape
    BooleanCut(const TopoDS_Shape& object,
               const TopoDS_Shape& tool,
               const double        fuzz = 0.0);

  asiAlgo_EXPORT TopoDS_Shape
    BooleanCut(const TopoDS_Shape&         object,
               const TopTools_ListOfShape& tools,
               const bool                  isParallel,
               const double                fuzz = 0.0);

  asiAlgo_EXPORT TopoDS_Shape
    BooleanCut(const TopoDS_Shape& object,
               const TopoDS_Shape& tool,
               const bool          isParallel,
               const double        fuzz,
               BRepAlgoAPI_Cut&    API);

  asiAlgo_EXPORT TopoDS_Shape
    BooleanCut(const TopoDS_Shape&         object,
               const TopTools_ListOfShape& tools,
               const bool                  isParallel,
               const double                fuzz,
               BRepAlgoAPI_Cut&            API);

  //! Fuses the passed shapes.
  //! \param[in] objects shapes to fuse.
  //! \return result of the Boolean operation.
  asiAlgo_EXPORT TopoDS_Shape
    BooleanFuse(const TopTools_ListOfShape& objects);

  //! Fuses the passed shapes.
  //! \param[in]  objects shapes to fuse.
  //! \param[in]  fuzz    fuzzy value (pass 0 to disable the "fuzzy" mode).
  //! \param[out] history accumulated modification history.
  //! \return result of the Boolean operation.
  asiAlgo_EXPORT TopoDS_Shape
    BooleanFuse(const TopTools_ListOfShape& objects,
                const double                fuzz,
                Handle(BRepTools_History)&  history);

  //! Fuses the passed shapes and optionally maximizes faces in the
  //! resulting shape.
  //! \param[in]  objects       shapes to fuse.
  //! \param[in]  maximizeFaces indicates whether to maximize faces of the
  //!                           result so that to reduce its complexity.
  //! \param[out] history       accumulated modification history.
  //! \return result of the Boolean operation.
  asiAlgo_EXPORT TopoDS_Shape
    BooleanFuse(const TopTools_ListOfShape& objects,
                const bool                  maximizeFaces,
                Handle(BRepTools_History)&  history);

  //! Performs Boolean Common for the passed pair of shapes.
  //! \param object1 [in] the first object.
  //! \param object2 [in] the second object.
  //! \param fuzzy   [in] the value of fuzzy tolerance.
  //! \return result shape.
  asiAlgo_EXPORT TopoDS_Shape
    BooleanCommon(const TopoDS_Shape& object1,
                  const TopoDS_Shape& object2,
                  const double        fuzz = 0.0);

  //! Performs Boolean intersection operation on the passed objects.
  //! \param[in] objects the shapes to intersect.
  //! \return the result of intersection.
  asiAlgo_EXPORT TopoDS_Shape
    BooleanCommon(const TopTools_ListOfShape& objects);

  asiAlgo_EXPORT TopoDS_Shape
    BooleanGeneralFuse(const TopTools_ListOfShape& objects,
                       const double                fuzz,
                       BOPAlgo_Builder&            API,
                       const bool                  glue = false);

  asiAlgo_EXPORT TopoDS_Shape
    BooleanGeneralFuse(const TopTools_ListOfShape& objects,
                       const double                fuzz,
                       const bool                  glue = false);

  asiAlgo_EXPORT bool
    BooleanRemoveFaces(const TopoDS_Shape&  shape,
                       const TopoDS_Shape&  face2Remove,
                       const bool           runParallel,
                       const bool           trackHistory,
                       TopoDS_Shape&        result,
                       ActAPI_ProgressEntry progress);

  asiAlgo_EXPORT bool
    BooleanRemoveFaces(const TopoDS_Shape&         shape,
                       const TopTools_ListOfShape& faces2Remove,
                       const bool                  runParallel,
                       const bool                  trackHistory,
                       TopoDS_Shape&               result,
                       ActAPI_ProgressEntry        progress);

  asiAlgo_EXPORT void
    ExplodeBySolids(const TopoDS_Shape&   model,
                    TopTools_ListOfShape& solids);

  asiAlgo_EXPORT bool
    InvertFace(const TopoDS_Face&    face,
               TopTools_ListOfShape& inverted);

  //! Constructs B-spline curve of degree 1 from the passed poles.
  //! \param[in] trace poles of the curve to construct.
  //! \return 1-degree spline curve.
  asiAlgo_EXPORT Handle(Geom_BSplineCurve)
    PolylineAsSpline(const TColgp_Array1OfPnt& trace);

  //! Constructs B-spline curve of degree 1 from the passed poles.
  //! \param[in] trace poles of the curve to construct.
  //! \return 1-degree spline curve.
  asiAlgo_EXPORT Handle(Geom_BSplineCurve)
    PolylineAsSpline(const std::vector<gp_XYZ>& trace);

  //! Constructs 2D B-spline curve of degree 1 from the passed poles.
  //! \param[in] trace poles of the curve to construct.
  //! \return 1-degree 2D spline curve.
  asiAlgo_EXPORT Handle(Geom2d_BSplineCurve)
    PolylineAsSpline(const TColgp_Array1OfPnt2d& trace);

  //! Constructs 2D B-spline curve of degree 1 from the passed poles.
  //! \param[in] trace poles of the curve to construct.
  //! \return 1-degree 2D spline curve.
  asiAlgo_EXPORT Handle(Geom2d_BSplineCurve)
    PolylineAsSpline(const std::vector<gp_XY>& trace);

  //! Checks whether the given shape contains the given sub-shape. This method
  //! builds a map of sub-shapes, so it is quite slow.
  //! \param[in] shape    master shape to check.
  //! \param[in] subShape sub-shape in question.
  //! \return true/false.
  asiAlgo_EXPORT bool
    Contains(const TopoDS_Shape& shape,
             const TopoDS_Shape& subShape);

  asiAlgo_EXPORT TopoDS_Shape
    GetImage(const TopoDS_Shape&       source,
             BRepBuilderAPI_MakeShape& API);

  asiAlgo_EXPORT Handle(Poly_Triangulation)
    CreateTriangle(const gp_Pnt& P0,
                   const gp_Pnt& P1,
                   const gp_Pnt& P2);

  asiAlgo_EXPORT void
    HexagonPoles(const gp_XY& center,
                 const double dist2Pole,
                 gp_XY&       P1,
                 gp_XY&       P2,
                 gp_XY&       P3,
                 gp_XY&       P4,
                 gp_XY&       P5,
                 gp_XY&       P6);

  //! Constructs a two-dimensional regular polygon.
  //! \param[in]  center    center point.
  //! \param[in]  dist2Pole radius of circumcircle.
  //! \param[in]  numPoles  number of poles in the resulting regular polygon.
  //! \param[out] poles     calculated poles.
  asiAlgo_EXPORT void
    PolygonPoles(const gp_XY&        center,
                 const double        dist2Pole,
                 const int           numPoles,
                 std::vector<gp_XY>& poles);

  //! Calculates normal vectors at interior face points. This method uses
  //! point membership classification to ensure that inner points only are
  //! used.
  //!
  //! CAUTION: Face orientation is not taken into account. The returned
  //!          normal vectors represent geometric orientation of
  //!          the face (i.e., the cross product of its partials).
  //!
  //! \param[in]  face       topological face in question.
  //! \param[in]  sampleRate sampling rate from (0, 1) interval.
  //! \param[out] points     sample points (internal or lying on the boundary).
  //! \param[out] vectors    computed normal field.
  //! \param[out] average    computed average normal.
  //!
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    CalculateFaceNormals(const TopoDS_Face&                 face,
                         const double                       sampleRate,
                         Handle(asiAlgo_BaseCloud<double>)& points,
                         Handle(asiAlgo_BaseCloud<double>)& vectors,
                         gp_Vec&                            average);

  //! This function takes "just any" interior point on a face.
  //!
  //! CAUTION: This function is not super-fast as it follows generate-and-test
  //!          approach, i.e., it samples many points and selects the one lying
  //!          INSIDE the face. Therefore, do not use this method in heavy loops.
  //!
  //! \param[in]  face topological face in question.
  //! \param[out] uv   UV coordinates of the selected point.
  //! \param[out] xyz  Cartesian coordinates of the selected point in the
  //!                  modeling space.
  //!
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    GetFaceAnyInteriorPoint(const TopoDS_Face& face,
                            gp_Pnt2d&          uv,
                            gp_Pnt&            xyz);

  //! Prints some useful analytics for the passed surface to the given
  //! output stream.
  //! \param[in]  surf parametric surface in question.
  //! \param[out] out  output stream.
  asiAlgo_EXPORT void
    PrintSurfaceDetails(const Handle(Geom_Surface)& surf,
                        Standard_OStream&           out);

  //! Calculates curvature comb for the passed curve at the given parameter
  //! value. The method follows the paper "Farin, G. 2016. Curvature combs
  //! and curvature plots. CAD Computer Aided Design 80, 6�8."
  //!
  //! \param[in]  curve    parametric curve to analyze.
  //! \param[in]  u        parameter value.
  //! \param[in]  curvAmpl curvature amplification factor used to bring out
  //!                      salient features of the comb.
  //! \param[out] p        point on curve at the given parameter value.
  //! \param[out] k        curvature at the given parameter value.
  //! \param[out] c        curvature comb.
  //!
  //! \return false if a comb cannot be calculated. NOTE: the output argument
  //!         <p> will be calculated anyway.
  asiAlgo_EXPORT bool
    CalculateCurvatureComb(const Handle(Geom_Curve)& curve,
                           const double              u,
                           const double              curvAmpl,
                           gp_Pnt&                   p,
                           double&                   k,
                           gp_Vec&                   c);

  //! Calculates curvature combs along the given curve.
  //!
  //! \param[in]  curve      parametric curve to analyze.
  //! \param[in]  f          first parameter of the range of interest.
  //! \param[in]  l          last parameter of the range of interest.
  //! \param[in]  numPts     number of discretization points.
  //! \param[in]  curvAmpl   curvature amplification factor used to bring out
  //!                        salient features of the comb.
  //! \param[out] points     discretization points.
  //! \param[out] params     discretization parameters.
  //! \param[out] curvatures curvatures.
  //! \param[out] combs      curvature combs.
  //! \param[out] combsOk    statuses of combs calculation.
  //!
  //! \return false if combs calculation is not possible on the passed data.
  asiAlgo_EXPORT bool
    CalculateCurvatureCombs(const Handle(Geom_Curve)& curve,
                            const double              f,
                            const double              l,
                            const int                 numPts,
                            const double              curvAmpl,
                            std::vector<gp_Pnt>&      points,
                            std::vector<double>&      params,
                            std::vector<double>&      curvatures,
                            std::vector<gp_Vec>&      combs,
                            std::vector<bool>&        combsOk);

  //! Calculates approximate strain energy of the passed curve. The strain
  //! energy is calculated as an integral of squared second derivative
  //! (instead of squared curvature).
  //! \param[in]  curve  parametric curve to calculate strain energy for.
  //! \param[out] result calculated strain energy.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    CalculateStrainEnergy(const Handle(Geom_Curve)& curve,
                          double&                   result);

  //! Calculates approximate bending energy of the passed surface. The strain
  //! energy is calculated as an area integral of squared second derivatives.
  //! \param[in]  surface parametric surface to calculate bending energy for.
  //! \param[out] result  calculated strain energy.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    CalculateBendingEnergy(const Handle(Geom_Surface)& surface,
                           double&                     result);

  //! Reparametrizes the given B-spline curve applying the passed new range
  //! for its knot vector.
  //!
  //! \param[in]  curve    B-spline curve to reparametrize.
  //! \param[in]  newFirst new first parameter value.
  //! \param[in]  newLast  new last parameter value.
  //! \param[in]  toCopy   indicates whether to prepare a copy of the
  //!                      input curve instead of directly modifying it.
  //! \param[out] result   reparametrized curve.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    ReparametrizeBSpl(const Handle(Geom2d_Curve)&  curve,
                      const double                 newFirst,
                      const double                 newLast,
                      const bool                   toCopy,
                      Handle(Geom2d_BSplineCurve)& result);

  //! This function is designed to evaluate curvature of the surface along the
  //! the given edge. It takes the tangency direction of the edge's curve for
  //! the passed parameter value and calculates the normal curvature at the
  //! corresponding point on surface.
  //! \param[in]  face face of interest.
  //! \param[in]  edge edge of interest.
  //! \param[in]  t    parameter on the edge's curve to evaluate curvature for.
  //! \param[out] UV   parametric coordinates of the sample point on the host
  //!                  surface.
  //! \param[out] k    evaluated curvature.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    EvaluateAlongCurvature(const TopoDS_Face& face,
                           const TopoDS_Edge& edge,
                           const double       t,
                           gp_Pnt2d&          UV,
                           double&            k);

  //! This function is designed to evaluate curvature of the surface along the
  //! the given edge. It takes the tangency direction of the edge's curve for
  //! the passed parameter value and calculates the normal curvature at the
  //! corresponding point on surface.
  //! \param[in]  face face of interest.
  //! \param[in]  edge edge of interest.
  //! \param[in]  t    parameter on the edge's curve to evaluate curvature for.
  //! \param[out] k    evaluated curvature.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    EvaluateAlongCurvature(const TopoDS_Face& face,
                           const TopoDS_Edge& edge,
                           const double       t,
                           double&            k);

  //! This function is designed to evaluate curvature of the surface along the
  //! the given edge. It takes the tangency direction of the edge's curve for
  //! the middle parameter value and calculates the normal curvature at the
  //! corresponding point on surface.
  //! \param[in]  face face of interest.
  //! \param[in]  edge edge of interest.
  //! \param[out] k    evaluated curvature.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    EvaluateAlongCurvature(const TopoDS_Face& face,
                           const TopoDS_Edge& edge,
                           double&            k);

  //! This function is designed to evaluate curvature of the surface along the
  //! the given edge. It takes the tangency direction of the edge's curve for
  //! the middle parameter value and calculates the normal curvature at the
  //! corresponding point on surface.
  //!
  //! \param[in]  face face of interest.
  //! \param[in]  edge edge of interest.
  //! \param[out] UV   parametric coordinates of the sample point on the host
  //!                  surface.
  //! \param[out] k    evaluated curvature.
  //!
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    EvaluateAlongCurvature(const TopoDS_Face& face,
                           const TopoDS_Edge& edge,
                           gp_Pnt2d&          UV,
                           double&            k);

  //! Calculates curvature in the middle of the passed curve.
  //! \param[in]  curve  curve in question.
  //! \param[out] P      point on curve.
  //! \param[out] T      tangent vector on curve.
  //! \param[out] k      evaluated curvature.
  //! \param[out] r      equivalent curvature radius.
  //! \param[out] center center of curvature.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    CalculateMidCurvature(const Handle(Geom_Curve)& curve,
                          gp_Pnt&                   P,
                          gp_Dir&                   T,
                          double&                   k,
                          double&                   r,
                          gp_Pnt&                   center);

  //! Calculates curvature in the middle of the passed curve.
  //! \param[in]  curve  curve in question.
  //! \param[out] k      evaluated curvature.
  //! \param[out] r      equivalent curvature radius.
  //! \param[out] center center of curvature.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    CalculateMidCurvature(const Handle(Geom_Curve)& curve,
                          double&                   k,
                          double&                   r,
                          gp_Pnt&                   center);

  //! Calculates curvature in the middle of the passed curve.
  //! \param[in]  curve curve in question.
  //! \param[out] k     evaluated curvature.
  //! \param[out] r     equivalent curvature radius.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    CalculateMidCurvature(const Handle(Geom_Curve)& curve,
                          double&                   k,
                          double&                   r);

  //! Integrates the passed function by midpoint (rectangle) rule.
  //! \param[in] F univariate function in question.
  //! \param[in] a lower bound.
  //! \param[in] a upper bound.
  //! \param[in] n number of bins.
  //! \return integral value.
  asiAlgo_EXPORT double
    IntegralRect(math_Function& F,
                 const double   a,
                 const double   b,
                 const int      n);

  //! Attempts to rebuild shape boundaries.
  //! \param[in] shape shape to refine.
  asiAlgo_EXPORT void
    RebuildBounds(TopoDS_Shape& shape);

  //! Gets a free edge that belongs to passed face and shares with
  //! it the given vertex.
  //! \param[in] EF      the edges-faces map.
  //! \param[in] hint    the vertex to resolve ambiguity.
  //! \param[in] exclude the edge to exclude from consideration to
  //!                    further resolve ambiguity.
  //! \return found free edge.
  asiAlgo_EXPORT TopoDS_Edge
    GetFreeEdge(const TopTools_IndexedDataMapOfShapeListOfShape& EF,
                const TopoDS_Vertex&                             hint,
                const TopoDS_Edge&                               exclude);

  //! Gets common (shared) edge between the two passed faces.
  //! \param[in]  F              first face.
  //! \param[in]  G              second face.
  //! \param[out] allCommonEdges all common edges.
  //! \param[in]  hint           vertex to resolve ambiguity.
  //! \return first common edge.
  asiAlgo_EXPORT TopoDS_Edge
    GetCommonEdge(const TopoDS_Shape&         F,
                  const TopoDS_Shape&         G,
                  TopTools_IndexedMapOfShape& allCommonEdges,
                  const TopoDS_Vertex&        hint = TopoDS_Vertex());

  //! Gets common (shared) edge between the two passed faces.
  //! \param[in] F first face.
  //! \param[in] G second face.
  //! \return first common edge.
  asiAlgo_EXPORT TopoDS_Edge
    GetCommonEdge(const TopoDS_Shape& F,
                  const TopoDS_Shape& G);

  //! Gets common (shared) edge between the two passed faces.
  //! \param[in] F    first face.
  //! \param[in] G    second face.
  //! \param[in] hint vertex to resolve ambiguity.
  //! \return first common edge.
  asiAlgo_EXPORT TopoDS_Edge
    GetCommonEdge(const TopoDS_Shape&  F,
                  const TopoDS_Shape&  G,
                  const TopoDS_Vertex& hint);

  //! Gets common edges for the passed face and it vertex.
  //! \param[in]  F     face in question.
  //! \param[in]  V     vertex in question.
  //! \param[out] edges found common edges.
  //! \return false if no common edges exist.
  asiAlgo_EXPORT bool
    GetCommonEdges(const TopoDS_Shape&         F,
                   const TopoDS_Vertex&        V,
                   TopTools_IndexedMapOfShape& edges);

  //! Gets common (shared) vertex between the three passed shapes.
  //! \param[in] F first shape.
  //! \param[in] G second shape.
  //! \param[in] H third shape.
  //! \return first common vertex.
  asiAlgo_EXPORT TopoDS_Vertex
    GetCommonVertex(const TopoDS_Shape& F,
                    const TopoDS_Shape& G,
                    const TopoDS_Shape& H);

  //! Gets common (shared) vertex between the two passed shapes.
  //! \param[in] F first shape.
  //! \param[in] G second shape.
  //! \return first common vertex.
  asiAlgo_EXPORT TopoDS_Vertex
    GetCommonVertex(const TopoDS_Shape& F,
                    const TopoDS_Shape& G);

  //! Gathers all faces which are neighbors to `F` through the edge `E`.
  //! \param[in]  shape master shape.
  //! \param[in]  F     face to find the neighbors for.
  //! \param[in]  E     edge to check neighbors in.
  //! \param[out] M     gathered collection of neighbor faces.
  //! \return false if the passed entities are not related.
  asiAlgo_EXPORT bool
    GetNeighborsThru(const TopoDS_Shape&         shape,
                     const TopoDS_Face&          F,
                     const TopoDS_Edge&          E,
                     TopTools_IndexedMapOfShape& M);

  //! Joins the passed pair of B-spline curves into a single curve.
  //! The resulting curve will have the passed continuity at joints. The input
  //! curves should be properly oriented.
  //! \param[in]  curve1   first B-curve to join.
  //! \param[in]  curve2   second B-curve to join.
  //! \param[in]  order    order of continuity to ensure.
  //! \param[out] result   joint curve.
  //! \param[in]  pregress progress notifier.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    JoinCurves(Handle(Geom_BSplineCurve)& curve1,
               Handle(Geom_BSplineCurve)& curve2,
               const int                  order,
               Handle(Geom_BSplineCurve)& result,
               ActAPI_ProgressEntry       progress);

  //! Joins the passed chain of B-spline curves into a single curve.
  //! The resulting curve will have the passed continuity at joints. The input
  //! curves should be properly oriented.
  //! \param[in]  curves   input B-curves to join.
  //! \param[in]  order    order of continuity to ensure.
  //! \param[out] result   joint curve.
  //! \param[in]  pregress progress notifier.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    JoinCurves(std::vector<Handle(Geom_BSplineCurve)>& curves,
               const int                               order,
               Handle(Geom_BSplineCurve)&              result,
               ActAPI_ProgressEntry                    progress);

  //! This method is the analogue of TopExp::MapShapes() except the fact that
  //! it populates a data map instead of an indexed map. Data maps can be
  //! used to store the same shapes under different indices (indexed map will
  //! throw an exception if you try to use its Substitute() method passed
  //! the already contained shape).
  //! \param[in]     S        shape to decompose.
  //! \param[out]    M        populated map of sub-shapes.
  //! \param[in,out] startIdx starting index (1-based indexation is the default).
  //! \param[out]    IM       indexed map to avoid duplicates and maintain
  //!                         equal identifiers in the data map and indexed map.
  asiAlgo_EXPORT void
    MapShapes(const TopoDS_Shape&         S,
              asiAlgo_DataMapOfShape&     M,
              int&                        startIdx,
              TopTools_IndexedMapOfShape& IM);

  //! This method is the analogue of TopExp::MapShapes() except the fact that
  //! it populates a data map instead of an indexed map. Data maps can be
  //! used to store the same shapes under different indices (indexed map will
  //! throw an exception if you try to use its Substitute() method passed
  //! the already contained shape).
  //! \param[in]  S shape to decompose.
  //! \param[out] M populated map of sub-shapes.
  asiAlgo_EXPORT void
    MapShapes(const TopoDS_Shape&     S,
              asiAlgo_DataMapOfShape& M);

  //! This method is the analogue of TopExp::MapShapes() except the fact that
  //! it does not distinguish sub-shapes with different locations.
  //! \param[in]  S shape to decompose.
  //! \param[out] M populated map of sub-shapes.
  asiAlgo_EXPORT void
    MapTShapes(const TopoDS_Shape&         S,
               asiAlgo_IndexedMapOfTShape& M);

  //! This method is the analogue of TopExp::MapShapes() except the fact that
  //! it does not distinguish sub-shapes with different locations.
  //! \param[in]  S shape to decompose.
  //! \param[in]  T sub-shape's type of interest.
  //! \param[out] M populated map of sub-shapes.
  asiAlgo_EXPORT void
    MapTShapes(const TopoDS_Shape&         S,
               const TopAbs_ShapeEnum      T,
               asiAlgo_IndexedMapOfTShape& M);

  //! This method is the analogue of TopExp::MapShapesAndAncestors() except
  //! the fact that it does not distinguish sub-shapes with different
  //! locations.
  //! \param[in]  S  shape to decompose.
  //! \param[in]  TS sub-shape's type of interest.
  //! \param[in]  TA ancestor's type of interest.
  //! \param[out] M  populated map of sub-shapes.
  asiAlgo_EXPORT void
    MapTShapesAndAncestors(const TopoDS_Shape&                        S,
                           const TopAbs_ShapeEnum                     TS,
                           const TopAbs_ShapeEnum                     TA,
                           asiAlgo_IndexedDataMapOfTShapeListOfShape& M);

  //! Checks whether the passed shape has any internal non-identity TopLoc_Location
  //! structures. In some algorithm, such internal locations are prohibited
  //! because these algorithms make an assumption that all boundary elements
  //! of a shape are unique.
  //! \param[in] S  shape to check.
  //! \param[in] ST indicates the shape type to search for internal locations.
  //!               E.g., if TopAbs_FACE is passed, this function will look
  //!               for the located face instances.
  //! \return true if some internal locations exist, false -- otheriwse.
  asiAlgo_EXPORT bool
    HasInternalLocations(const TopoDS_Shape&    S,
                         const TopAbs_ShapeEnum ST = TopAbs_SHAPE);

  //! Often in practice a part is represented with a compound having some
  //! internal instances (i.e., the located occurrences of nested shapes).
  //! Such a data structure is a bad mix of part vs assembly concept. However,
  //! we have to deal with such complex part as they are not something
  //! exotic (to get one, it is enough to read a STEP assembly into a
  //! single TopoDS_Shape).
  //!
  //! The level of the topology graph where the instancing interrupts
  //! corresponds to the level of a real part definition. A part per se can
  //! be a solid, a shell or whatever entity not excluding another compound
  //! without a location. This function is used to extract real parts from
  //! the passed shape. The extracted shapes have no locations.
  //!
  //! \param[in]  S     shape in question.
  //! \param[out] parts extracted real parts (shapes without locations).
  asiAlgo_EXPORT void
    IsolateRealParts(const TopoDS_Shape&   S,
                     TopTools_ListOfShape& parts);

  //! Finds a shape in the given list which contains the passed subshape.
  //! \param[in] parts    list of shapes to check.
  //! \param[in] subshape subshape to find.
  //! \return found shape from the list or null shape if nothing was found.
  asiAlgo_EXPORT TopoDS_Shape
    FindBySubshape(const TopTools_ListOfShape& parts,
                   const TopoDS_Shape&         subshape);

  //! Extracts sub-triangulation from the given source by the passed indices.
  //! Only the mesh elements with the passed indices will be returned in a new
  //! triangulation.
  //! \param[in] mesh     source triangulation.
  //! \param[in] elems    elements to keep.
  //! \param[in] oneBased indicates whether the passed indices are 0-based or 1-based.
  //! \return sub-triangulation.
  asiAlgo_EXPORT Handle(Poly_Triangulation)
    GetSubMesh(const Handle(Poly_Triangulation)& mesh,
               const TColStd_PackedMapOfInteger& elems,
               const bool                        oneBased);

  //! Computes the average point for the passed point set.
  //! \param[in] pts point set in question.
  //! \return average point.
  asiAlgo_EXPORT gp_XYZ
    ComputeAveragePoint(const std::vector<gp_XYZ>& pts);

  //! Fixed version of BRepTools::OuterWire (see #31172 in the OpenCascade
  //! bugtracker).
  //! \param[in] face    the face in question.
  //! \param[in] plotter the imperative plotter for diagnostic visual dumps.
  //! \return outer wire.
  asiAlgo_EXPORT TopoDS_Wire
    ComputeOuterWire(const TopoDS_Face&  face,
                     ActAPI_PlotterEntry plotter = nullptr);

  //! Computes and caches the outer wire for the passed face. If the outer wire
  //! is already computed, it is returned from the corresponding attribute.
  //! \param[in] fid the ID of the face in question.
  //! \param[in] aag the attribute adjacency graph.
  //! \return the computed or cached outer wire.
  asiAlgo_EXPORT TopoDS_Wire
    CacheOuterWire(const int                  fid,
                   const Handle(asiAlgo_AAG)& aag);

  //! Computes random inner point on a face.
  //! \param[in]     face the face of interest.
  //! \param[in,out] RNG  the random number generator.
  //! \param[out]    uv   the `(u,v)` coordinates of the random point in
  //!                     the bounded face's parametric space.
  //! \param[in]     aag  the optional attributed adjacency graph for
  //!                     caching UV bounds.
  //! \return false if an inner point cannot be queried (e.g., if the face is
  //!         very invalid).
  asiAlgo_EXPORT bool
    GetRandomPoint(const TopoDS_Face&         face,
                   math_BullardGenerator&     RNG,
                   gp_Pnt2d&                  uv,
                   const Handle(asiAlgo_AAG)& aag = nullptr);

  //! Computes local reference frame for the passed face.
  //! \param[in]  face       target face.
  //! \param[in]  alongEdges indicates whether the X direction of the
  //!                        reference frame should follow one of the edges.
  //! \param[out] axes       computed axes.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    GetLocalFrame(const TopoDS_Face& face,
                  const bool         alongEdges,
                  gp_Ax3&            axes);

  //! Computes local norm for the passed face taking into account its orientation.
  //! \param[in]  face the target face.
  //! \param[in]  u    the U coordinate of the probe point.
  //! \param[in]  v    the V coordinate of the probe point.
  //! \param[out] P    the point of `S(u,v)`, where `S` is the face's host surface.
  //! \param[out] N    the evaluated normal vector or `(0,0,0)` in irregular points.
  //! \return true if the norm is defined, false -- otherwise.
  asiAlgo_EXPORT bool
    GetFaceNorm(const TopoDS_Face& face,
                const double       u,
                const double       v,
                gp_Pnt&            P,
                gp_Vec&            N);

  //! Calculates border trihedron for the given face.
  //! \param[in]  face     the face to analyze.
  //! \param[in]  edge     the border edge lying on the `face` to calculate
  //!                      the trihedron for.
  //! \param[in]           the parameter along the edge.
  //! \param[out] btri     the border axes.
  //! \param[in]  progress the progress notifier.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    ComputeBorderTrihedron(const TopoDS_Face&       face,
                           const TopoDS_Edge&       edge,
                           const double             t,
                           asiAlgo_BorderTrihedron& btri,
                           ActAPI_ProgressEntry     progress = nullptr);

  //! Calculates border trihedron for the given face.
  //! \param[in]  face     face to analyze.
  //! \param[in]  edge     border edge lying on the `face` to calculate
  //!                      the trihedron for.
  //! \param[out] btri     border axes.
  //! \param[in]  progress progress notifier.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    ComputeBorderTrihedron(const TopoDS_Face&       face,
                           const TopoDS_Edge&       edge,
                           asiAlgo_BorderTrihedron& btri,
                           ActAPI_ProgressEntry     progress = nullptr);

  //! Extract geometry summary for the passed shape.
  asiAlgo_EXPORT void
    GeomSummary(const TopoDS_Shape&  shape,
                asiAlgo_GeomSummary& summary);

  //! Computes the minimal-angle arc for the passed directions.
  //! \param[in] dirs the directions to check.
  //! \param[in] norm the normal vector to determine angle signs.
  //! \return angle of the minimal arc spanned by the passed vectors.
  asiAlgo_EXPORT double
    MinArcAngle(const std::vector<gp_Vec>& dirs,
                const gp_Dir&              norm);

  //! Checks whether the passed two axes are coaxial.
  //! \param[in] a1          the first axis.
  //! \param[in] a2          the second axis.
  //! \param[in] angTolerDeg the angular tolerance (in degrees).
  //! \param[in] linToler    the linear tolerance (in model units).
  //! \return true/false.
  asiAlgo_EXPORT bool
    AreCoaxial(const gp_Ax1& a1,
               const gp_Ax1& a2,
               const double  angTolerDeg,
               const double  linToler);

  //! Checks if the passed curve is equidistant from the given axis, i.e., it
  //! lies on a cylindrical surface.
  //! \param[in]  curve the curve to check.
  //! \param[in]  axis  the known axis to check the passed curve against.
  //! \param[in]  tol   the linear tolerance value to use for the deviation check.
  //! \param[out] r     the extracted radius value.
  //! \return true if the curve lies on a cylinder, false -- otherwise.
  asiAlgo_EXPORT bool
    IsOnCylinder(const Handle(Geom_Curve)& curves,
                 const gp_Ax1&             axis,
                 const double              tol,
                 double&                   r);

  //! Checks if the passed curves are equidistant from the given axis, i.e., they
  //! all lie on a cylindrical surface.
  //! \param[in]  curves the curves to check.
  //! \param[in]  axis   the known axis to check the curves against.
  //! \param[in]  tol    the linear tolerance value to use for the deviation check.
  //! \param[out] r      the extracted radius value.
  //! \return true if the curves lie on a cylinder, false -- otherwise.
  asiAlgo_EXPORT bool
    IsOnCylinder(const std::vector<Handle(Geom_Curve)>& curves,
                 const gp_Ax1&                          axis,
                 const double                           tol,
                 double&                                r);

  //! Checks whether the passed curve `curve` lies on the given cylindrical
  //! surface `cyl`.
  //! \param[in] curve   the curve to check.
  //! \param[in] cyl     the candidate cylinder.
  //! \param[in] tol     the linear tolerance value to use for the deviation check.
  //! \param[in] plotter the imperative plotter to use.
  //! \return true if the curve lies on a cylinder, false -- otherwise.
  asiAlgo_EXPORT bool
    IsOnCylinder(const Handle(Geom_Curve)& curve,
                 const gp_Cylinder&        cyl,
                 const double              tol,
                 ActAPI_PlotterEntry       plotter = nullptr);

  //! Returns a set of points presumably lying on the given face.
  //! \param[in]  face         the face in question.
  //! \param[in]  midPoints    the Boolean flag indicating whether to add each edge's middle points.
  //! \param[in]  triangPoints the Boolean flag indicating whether to add face triangulation points.
  //! \param[out] pts          the sampled points.
  asiAlgo_EXPORT void
    GetFacePoints(const TopoDS_Face&   face,
                  const bool           midPoints,
                  const bool           triangPoints,
                  std::vector<gp_XYZ>& pts);

  //! Returns a set of points lying on the triangulation of the given face.
  //! \param[in]  face    the face in question.
  //! \param[in]  tol     the 3D tolerance to merge points close to each other. Pass
  //!                     0 to avoid filtering.
  //! \param[out] samples the sampled points on a face with their associated norms.
  //!                     Each point is a pair of triangle ID and the axis.
  //! \return false if the face of interest is not triangulated, so sampling is impossible.
  asiAlgo_EXPORT bool
    GetFacePointsByFacets(const TopoDS_Face&                     face,
                          const double                           tol,
                          std::vector< std::pair<int, gp_Ax1> >& samples);

  //! Checks if the passed face is internal or external, depending
  //! on its norm field orientation.
  //! \param[in] face     the face to check.
  //! \param[in] diameter the presumably known diameter.
  //! \param[in] ax       the presumably known axis.
  //! \return true for internal, false for external.
  asiAlgo_EXPORT bool
    IsInternal(const TopoDS_Face& face,
               const double       diameter,
               const gp_Ax1&      ax);

  //! Checks if the passed face is internal or external, depending
  //! on its norm field orientation.
  //! \param[in] face     the face to check.
  //! \param[in] diameter the presumably known diameter.
  //! \param[in] u        the U coordinate of the probe point on the face of interest.
  //! \param[in] v        the V coordinate of the probe point on the face of interest.
  //! \param[in] ax       the presumably known axis.
  //! \return true for internal, false for external.
  asiAlgo_EXPORT bool
    IsInternal(const TopoDS_Face& face,
               const double       diameter,
               const double       u,
               const double       v,
               const gp_Ax1&      ax);

  //! Projects a point onto a plane in a specified direction.
  //! \param[in]  plane plane.
  //! \param[in]  dir   direction.
  //! \param[in]  point point.
  //! \param[out] proj  projection of point.
  //! \return true in case of success false -- otherwise.
  asiAlgo_EXPORT bool
    ProjectPointOnPlane(const Handle(Geom_Plane)& plane,
                        const gp_Dir&             dir,
                        const gp_Pnt&             point,
                        gp_Pnt&                   proj);

  //! Returns the indices of all edges parallel to the passed direction
  //! `dir` in the UV space of the given face `fid`.
  //! \param[in]  fid       the 1-based index of the face to inspect.
  //! \param[in]  aag       the attributed adjacency graph.
  //! \param[in]  dir       the direction of interest.
  //! \param[in]  tolAngDeg the angular tolerance (in degrees) to use.
  //! \param[out] eids      the collected edge IDs.
  asiAlgo_EXPORT void
    GetEdgesParallelTo(const int                   fid,
                       const Handle(asiAlgo_AAG)&  aag,
                       const gp_Dir2d&             dir,
                       const double                tolAngDeg,
                       TColStd_PackedMapOfInteger& eids);

  //! Returns the indices of all vertical edges in the UV space of the
  //! passed face `fid`.
  //! \param[in] fid       the 1-based index of the face to inspect.
  //! \param[in] aag       the attributed adjacency graph.
  //! \param[in] tolAngDeg the angular tolerance (in degrees) to use.
  //! \return the collection of 1-based edge indices.
  asiAlgo_EXPORT TColStd_PackedMapOfInteger
    GetVerticalEdges(const int                  fid,
                     const Handle(asiAlgo_AAG)& aag,
                     const double               tolAngDeg);

  //! Intersects the host surfaces of the passed pair of faces.
  //! \param[in]  F1  the first face to intersect.
  //! \param[in]  F2  the second face to intersect.
  //! \param[out] res the intersection curve.
  //! \return true in the case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    IntersectSurfaces(const TopoDS_Face&                   F1,
                      const TopoDS_Face&                   F2,
                      Handle(asiAlgo_IntersectionCurveSS)& res);

  //! Finds all internal (nonmanifold) faces in the passed shape.
  //! \param[in]  shape   the shape of interest.
  //! \param[out] nmFaces the collected nonmanifold faces.
  //! \param[out] mFaces  the collected manifold faces.
  //! \param[in]  plotter the imperative plotter.
  //! \return the number of detected nonmanifold faces.
  asiAlgo_EXPORT int
    FindNonmanifoldFaces(const TopoDS_Shape&         shape,
                         asiAlgo_IndexedMapOfTShape& nmFaces,
                         asiAlgo_IndexedMapOfTShape& mFaces,
                         ActAPI_PlotterEntry         plotter = nullptr);

} // asiAlgo_Utils namespace.

#endif
